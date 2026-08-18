import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DirectIdentity {
  publicKey: string
  privateKey: string
  fingerprint: string
  encryptionPublicKey: string
  encryptionPrivateKey: string
  deviceId: string
}

interface StoredIdentityV1 {
  version: 1
  publicKey: string
  privateKey: string
}

interface StoredIdentityV2 {
  version: 2
  publicKey: string
  privateKey: string
  encryptionPublicKey: string
  encryptionPrivateKey: string
  deviceId: string
}

export function fingerprintPublicKey(publicKey: string): string {
  const der = Buffer.from(publicKey, 'base64url')
  createPublicKey({ key: der, format: 'der', type: 'spki' })
  return `ed25519:${createHash('sha256').update(der).digest('base64url')}`
}

export function createDirectIdentity(): DirectIdentity {
  const pair = generateKeyPairSync('ed25519')
  const encryptionPair = generateKeyPairSync('x25519')
  const publicKey = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url')
  const privateKey = pair.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64url')
  const encryptionPublicKey = encryptionPair.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url')
  const encryptionPrivateKey = encryptionPair.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64url')
  return {
    publicKey,
    privateKey,
    fingerprint: fingerprintPublicKey(publicKey),
    encryptionPublicKey,
    encryptionPrivateKey,
    deviceId: randomBytes(12).toString('base64url'),
  }
}

export function openDirectIdentity(filePath: string): DirectIdentity {
  if (existsSync(filePath)) {
    const parsed = parseStoredIdentity(readFileSync(filePath, 'utf8'))
    if (parsed.migrated) persistIdentity(filePath, parsed.identity)
    return parsed.identity
  }

  const identity = createDirectIdentity()
  persistIdentity(filePath, identity)
  return identity
}

function persistIdentity(filePath: string, identity: DirectIdentity): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  const stored: StoredIdentityV2 = {
    version: 2,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    encryptionPrivateKey: identity.encryptionPrivateKey,
    deviceId: identity.deviceId,
  }
  writeFileSync(tmp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}

export function signText(identity: DirectIdentity, text: string): string {
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  })
  return sign(null, Buffer.from(text, 'utf8'), key).toString('base64url')
}

export function verifyText(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    })
    return verify(
      null,
      Buffer.from(text, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return false
  }
}

function parseStoredIdentity(text: string): { identity: DirectIdentity; migrated: boolean } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('direct identity file is not valid JSON; restore it instead of generating a new identity')
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('direct identity file is invalid')
  const stored = raw as {
    version?: 1 | 2
    publicKey?: string
    privateKey?: string
    encryptionPublicKey?: string
    encryptionPrivateKey?: string
    deviceId?: string
  }
  if (
    (stored.version !== 1 && stored.version !== 2) ||
    typeof stored.publicKey !== 'string' ||
    typeof stored.privateKey !== 'string'
  ) {
    throw new Error('direct identity file has an unsupported format')
  }

  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(stored.privateKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    })
    const derivedPublic = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64url')
    if (derivedPublic !== stored.publicKey) throw new Error('public/private key mismatch')
    let encryptionPublicKey = stored.encryptionPublicKey
    let encryptionPrivateKey = stored.encryptionPrivateKey
    let deviceId = stored.deviceId
    const migrated = stored.version === 1
    if (migrated) {
      const encryptionPair = generateKeyPairSync('x25519')
      encryptionPublicKey = encryptionPair.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url')
      encryptionPrivateKey = encryptionPair.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64url')
      deviceId = randomBytes(12).toString('base64url')
    }
    if (
      typeof encryptionPublicKey !== 'string' ||
      typeof encryptionPrivateKey !== 'string' ||
      typeof deviceId !== 'string' ||
      deviceId.length < 8
    ) throw new Error('missing encryption identity')
    const encryptionPrivate = createPrivateKey({
      key: Buffer.from(encryptionPrivateKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    })
    const derivedEncryptionPublic = createPublicKey(encryptionPrivate)
      .export({ format: 'der', type: 'spki' })
      .toString('base64url')
    if (derivedEncryptionPublic !== encryptionPublicKey) throw new Error('encryption public/private key mismatch')
    return { identity: {
      publicKey: stored.publicKey,
      privateKey: stored.privateKey,
      fingerprint: fingerprintPublicKey(stored.publicKey),
      encryptionPublicKey,
      encryptionPrivateKey,
      deviceId,
    }, migrated }
  } catch (err) {
    throw new Error(`direct identity file is corrupt: ${(err as Error).message}`)
  }
}
