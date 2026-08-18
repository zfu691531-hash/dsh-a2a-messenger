import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import type { Contact, ContactStore } from './contacts.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DirectIdentity } from './direct/identity.js'
import { fingerprintPublicKey, signText, verifyText } from './direct/identity.js'
import type { IncomingMessage } from './types.js'
import type { TransportSendInput } from './transport.js'

const PREFIX = 'DSH1-'
const MAX_ENVELOPE_CHARS = 512_000
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RENDEZVOUS_TTL_MS = 10 * 60 * 1000

interface SealedBox {
  recipient: string
  iv: string
  ciphertext: string
  tag: string
}

interface EnvelopeSender {
  name: string
  deviceId: string
  fingerprint: string
  publicKey: string
  encryptionPublicKey: string
}

interface UnsignedEnvelope {
  v: 1
  id: string
  createdAt: number
  expiresAt: number
  sender: EnvelopeSender
  boxes: SealedBox[]
}

interface SealedEnvelope extends UnsignedEnvelope {
  signature: string
}

interface EnvelopePayload {
  content: string
  channel?: string
  to?: string
  kind: 'message' | 'rendezvous'
}

export interface EnvelopeCodecOptions {
  selfName: string
  identity: DirectIdentity
  contacts: ContactStore
  ttlMs?: number
  now?: () => number
  replayFile?: string
}

export class MailboxEnvelopeCodec {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly seen = new Map<string, number>()

  constructor(private readonly opts: EnvelopeCodecOptions) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.loadReplayState()
  }

  seal(input: TransportSendInput): string {
    const recipients = this.resolveRecipients(input)
    if (recipients.length === 0) throw new Error('sealed mailbox has no eligible recipients with encryption keys')
    const id = randomUUID()
    const createdAt = this.now()
    const expiresAt = createdAt + (input.kind === 'rendezvous' ? RENDEZVOUS_TTL_MS : this.ttlMs)
    const payload: EnvelopePayload = {
      content: input.content,
      channel: input.channel,
      to: input.to,
      kind: input.kind ?? 'message',
    }
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
    const sender: EnvelopeSender = {
      name: this.opts.selfName,
      deviceId: this.opts.identity.deviceId,
      fingerprint: this.opts.identity.fingerprint,
      publicKey: this.opts.identity.publicKey,
      encryptionPublicKey: this.opts.identity.encryptionPublicKey,
    }
    const boxes = recipients
      .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
      .map((contact) => this.encryptFor(contact, id, createdAt, expiresAt, plaintext))
    const unsigned: UnsignedEnvelope = { v: 1, id, createdAt, expiresAt, sender, boxes }
    const envelope: SealedEnvelope = {
      ...unsigned,
      signature: signText(this.opts.identity, canonicalEnvelope(unsigned)),
    }
    return PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
  }

  open(value: string): IncomingMessage | undefined {
    const envelope = decodeEnvelope(value)
    if (!envelope) throw new Error('invalid sealed mailbox envelope')
    if (envelope.sender.fingerprint === this.opts.identity.fingerprint) return undefined
    const now = this.now()
    if (envelope.expiresAt < now) throw new Error('sealed mailbox envelope expired')
    if (envelope.createdAt > now + 5 * 60_000) throw new Error('sealed mailbox envelope is from the future')
    const contact = this.opts.contacts.find(envelope.sender.fingerprint)
    if (!contact || contact.trust === 'revoked') throw new Error(`sealed message from untrusted peer ${envelope.sender.fingerprint}`)
    if (
      contact.name !== envelope.sender.name ||
      contact.deviceId !== envelope.sender.deviceId ||
      contact.publicKey !== envelope.sender.publicKey ||
      contact.encryptionPublicKey !== envelope.sender.encryptionPublicKey
    ) throw new Error('sealed message sender identity does not match the contact record')
    if (fingerprintPublicKey(envelope.sender.publicKey) !== envelope.sender.fingerprint) {
      throw new Error('sealed message sender fingerprint is invalid')
    }
    const { signature, ...unsigned } = envelope
    if (!verifyText(envelope.sender.publicKey, canonicalEnvelope(unsigned), signature)) {
      throw new Error('sealed mailbox envelope signature is invalid')
    }
    const box = envelope.boxes.find((candidate) => candidate.recipient === this.opts.identity.fingerprint)
    if (!box) return undefined
    this.pruneReplayState(now)
    if (this.seen.has(envelope.id)) throw new Error('sealed mailbox envelope replayed')
    const payload = this.decrypt(box, envelope)
    if (
      payload.kind === 'rendezvous' &&
      envelope.expiresAt - envelope.createdAt > RENDEZVOUS_TTL_MS
    ) throw new Error('rendezvous envelope lifetime exceeds 10 minutes')
    this.seen.set(envelope.id, envelope.expiresAt)
    try {
      this.persistReplayState()
    } catch (err) {
      this.seen.delete(envelope.id)
      throw err
    }
    return {
      id: `sealed-${envelope.sender.fingerprint.slice(-12)}-${envelope.id}`,
      from: contact.name,
      fromFingerprint: contact.fingerprint,
      channel: payload.channel,
      content: payload.content,
      ts: envelope.createdAt,
      security: 'sealed',
      protocol: payload.kind === 'rendezvous' ? 'rendezvous' : undefined,
    }
  }

  static isSealed(value: string): boolean {
    return value.trim().startsWith(PREFIX)
  }

  recipientName(selector: string): string {
    const contact = this.opts.contacts.find(selector)
    if (!contact || contact.trust === 'revoked') throw new Error(`active contact "${selector}" not found`)
    return contact.name
  }

  private resolveRecipients(input: TransportSendInput): Contact[] {
    if (input.to) {
      const contact = this.opts.contacts.find(input.to)
      if (!contact || contact.trust === 'revoked') throw new Error(`active contact "${input.to}" not found`)
      if (!contact.encryptionPublicKey) throw new Error(`contact "${contact.name}" has no encryption key; exchange a pairing card`)
      return [contact]
    }
    return this.opts.contacts.active().filter((contact) => Boolean(contact.encryptionPublicKey))
  }

  private encryptFor(
    contact: Contact,
    id: string,
    createdAt: number,
    expiresAt: number,
    plaintext: Buffer,
  ): SealedBox {
    const iv = randomBytes(12)
    const key = this.sharedKey(contact.encryptionPublicKey, id, contact.fingerprint)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad(id, createdAt, expiresAt, this.opts.identity.fingerprint, contact.fingerprint))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
      recipient: contact.fingerprint,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    }
  }

  private decrypt(box: SealedBox, envelope: SealedEnvelope): EnvelopePayload {
    try {
      const key = this.sharedKey(
        envelope.sender.encryptionPublicKey,
        envelope.id,
        this.opts.identity.fingerprint,
      )
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'))
      decipher.setAAD(aad(
        envelope.id,
        envelope.createdAt,
        envelope.expiresAt,
        envelope.sender.fingerprint,
        this.opts.identity.fingerprint,
      ))
      decipher.setAuthTag(Buffer.from(box.tag, 'base64url'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(box.ciphertext, 'base64url')),
        decipher.final(),
      ])
      const raw = JSON.parse(plaintext.toString('utf8')) as Partial<EnvelopePayload>
      if (
        typeof raw.content !== 'string' ||
        (raw.kind !== 'message' && raw.kind !== 'rendezvous') ||
        (raw.channel !== undefined && typeof raw.channel !== 'string') ||
        (raw.to !== undefined && typeof raw.to !== 'string')
      ) throw new Error('invalid payload')
      return raw as EnvelopePayload
    } catch (err) {
      throw new Error(`sealed mailbox decryption failed: ${(err as Error).message}`)
    }
  }

  private sharedKey(remotePublicKey: string, id: string, recipient: string): Buffer {
    const secret = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.from(this.opts.identity.encryptionPrivateKey, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      }),
      publicKey: createPublicKey({
        key: Buffer.from(remotePublicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
    })
    return Buffer.from(hkdfSync('sha256', secret, Buffer.from(id), Buffer.from(`dsh-a2a:${recipient}`), 32))
  }

  private loadReplayState(): void {
    const file = this.opts.replayFile
    if (!file || !existsSync(file)) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { seen?: Record<string, number> }
      if (raw.seen && typeof raw.seen === 'object') {
        for (const [id, expiresAt] of Object.entries(raw.seen)) {
          if (typeof expiresAt === 'number' && expiresAt >= this.now()) this.seen.set(id, expiresAt)
        }
      }
    } catch {
      throw new Error('mailbox replay state is corrupt')
    }
  }

  private pruneReplayState(now: number): void {
    for (const [id, expiresAt] of this.seen) if (expiresAt < now) this.seen.delete(id)
  }

  private persistReplayState(): void {
    const file = this.opts.replayFile
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, seen: Object.fromEntries(this.seen) }), 'utf8')
    renameSync(tmp, file)
  }
}

function aad(id: string, createdAt: number, expiresAt: number, sender: string, recipient: string): Buffer {
  return Buffer.from(JSON.stringify([id, createdAt, expiresAt, sender, recipient]), 'utf8')
}

function canonicalEnvelope(envelope: UnsignedEnvelope): string {
  return JSON.stringify([
    envelope.v,
    envelope.id,
    envelope.createdAt,
    envelope.expiresAt,
    envelope.sender.name,
    envelope.sender.deviceId,
    envelope.sender.fingerprint,
    envelope.sender.publicKey,
    envelope.sender.encryptionPublicKey,
    envelope.boxes.map((box) => [box.recipient, box.iv, box.ciphertext, box.tag]),
  ])
}

function decodeEnvelope(value: string): SealedEnvelope | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith(PREFIX) || trimmed.length > MAX_ENVELOPE_CHARS) return undefined
  try {
    const raw = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8')) as SealedEnvelope
    if (
      raw.v !== 1 ||
      typeof raw.id !== 'string' || raw.id.length > 128 ||
      typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) ||
      typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) ||
      raw.expiresAt <= raw.createdAt ||
      typeof raw.signature !== 'string' || raw.signature.length > 256 ||
      typeof raw.sender !== 'object' || raw.sender === null ||
      typeof raw.sender.name !== 'string' ||
      typeof raw.sender.deviceId !== 'string' ||
      typeof raw.sender.fingerprint !== 'string' ||
      typeof raw.sender.publicKey !== 'string' ||
      typeof raw.sender.encryptionPublicKey !== 'string' ||
      !Array.isArray(raw.boxes) || raw.boxes.length === 0 || raw.boxes.length > 256
    ) return undefined
    for (const box of raw.boxes) {
      if (
        typeof box.recipient !== 'string' ||
        typeof box.iv !== 'string' ||
        typeof box.ciphertext !== 'string' ||
        typeof box.tag !== 'string'
      ) return undefined
    }
    return raw
  } catch {
    return undefined
  }
}
