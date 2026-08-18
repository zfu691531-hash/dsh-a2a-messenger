import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CompositeTransport,
  ContactStore,
  FilesystemTransport,
  GitHubTransport,
  MailboxEnvelopeCodec,
  MessengerService,
  QuarantineInbox,
  RendezvousCoordinator,
  DirectSessionManager,
  SecureTransport,
  createDirectIdentity,
  encodeContactCard,
  openDirectIdentity,
} from '../lib/index.js'
import { startMockGitHub } from './mock-github-server.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-a2a-suite-'))
}

function paired() {
  const root = tempDir()
  const aliceIdentity = createDirectIdentity()
  const bobIdentity = createDirectIdentity()
  const aliceContacts = ContactStore.open(join(root, 'alice-contacts.json'))
  const bobContacts = ContactStore.open(join(root, 'bob-contacts.json'))
  aliceContacts.acceptCard(encodeContactCard('bob', 'laptop', bobIdentity, 1_000))
  bobContacts.acceptCard(encodeContactCard('alice', 'desktop', aliceIdentity, 1_000))
  return { root, aliceIdentity, bobIdentity, aliceContacts, bobContacts }
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timed out')
}

test('v1 signing identity migrates without fingerprint rotation', () => {
  const root = tempDir()
  try {
    const file = join(root, 'identity.json')
    const original = createDirectIdentity()
    writeFileSync(file, JSON.stringify({ version: 1, publicKey: original.publicKey, privateKey: original.privateKey }))
    const migrated = openDirectIdentity(file)
    assert.equal(migrated.fingerprint, original.fingerprint)
    assert.ok(migrated.encryptionPublicKey)
    assert.ok(migrated.deviceId)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pairing cards bind person, device, signing key, and encryption key', () => {
  const pair = paired()
  try {
    const contact = pair.aliceContacts.find('bob@laptop')
    assert.equal(contact.trust, 'tofu')
    assert.equal(contact.deviceId, pair.bobIdentity.deviceId)
    assert.equal(contact.encryptionPublicKey, pair.bobIdentity.encryptionPublicKey)
    pair.aliceContacts.verify('bob@laptop', contact.fingerprint.slice(-12))
    assert.equal(pair.aliceContacts.find(contact.fingerprint).trust, 'verified')
    pair.aliceContacts.revoke('bob@laptop')
    assert.equal(pair.aliceContacts.find(contact.fingerprint).trust, 'revoked')
  } finally {
    rmSync(pair.root, { recursive: true, force: true })
  }
})

test('sealed envelopes decrypt only for the paired recipient and detect tampering', () => {
  const pair = paired()
  try {
    const alice = new MailboxEnvelopeCodec({
      selfName: 'alice', identity: pair.aliceIdentity, contacts: pair.aliceContacts, now: () => 2_000,
    })
    const bob = new MailboxEnvelopeCodec({
      selfName: 'bob', identity: pair.bobIdentity, contacts: pair.bobContacts, now: () => 2_001,
    })
    const sealed = alice.seal({ to: 'bob@laptop', content: 'secret', kind: 'message' })
    const opened = bob.open(sealed)
    assert.equal(opened.content, 'secret')
    assert.equal(opened.from, 'alice')
    assert.equal(opened.security, 'sealed')
    assert.throws(() => bob.open(sealed), /replayed/)
    const expiredBob = new MailboxEnvelopeCodec({
      selfName: 'bob', identity: pair.bobIdentity, contacts: pair.bobContacts,
      now: () => 8 * 24 * 60 * 60 * 1000,
    })
    assert.throws(() => expiredBob.open(sealed), /expired/)
    const last = sealed.at(-1)
    const tampered = sealed.slice(0, -1) + (last === 'A' ? 'B' : 'A')
    assert.throws(() => bob.open(tampered), /invalid|signature|decryption/)
  } finally {
    rmSync(pair.root, { recursive: true, force: true })
  }
})

test('sealed filesystem mailbox round-trips and refuses readable downgrade', async () => {
  const pair = paired()
  try {
    const shared = join(pair.root, 'shared')
    const aliceCodec = new MailboxEnvelopeCodec({
      selfName: 'alice', identity: pair.aliceIdentity, contacts: pair.aliceContacts,
    })
    const bobCodec = new MailboxEnvelopeCodec({
      selfName: 'bob', identity: pair.bobIdentity, contacts: pair.bobContacts,
    })
    const aliceRaw = new FilesystemTransport({ directory: shared, selfName: 'alice' })
    const bobRaw = new FilesystemTransport({ directory: shared, selfName: 'bob' })
    const alice = new SecureTransport(aliceRaw, 'sealed', aliceCodec)
    const bob = new SecureTransport(bobRaw, 'sealed', bobCodec)
    const received = []
    const errors = []
    bob.start({ onMessage: (message) => received.push(message), onError: (error) => errors.push(error) })
    await alice.send({ to: 'bob@laptop', content: 'over shared folder' })
    const deliveredOffer = await bobRaw.pollOnce()
    assert.equal(deliveredOffer, 1)
    assert.equal(received[0].content, 'over shared folder')
    assert.equal(received[0].route, 'filesystem')

    await aliceRaw.send({ to: 'bob', content: 'plaintext downgrade' })
    await bobRaw.pollOnce()
    assert.equal(received.length, 1)
    assert.match(errors.at(-1).message, /refused readable message/)
    await bob.stop()
  } finally {
    rmSync(pair.root, { recursive: true, force: true })
  }
})

test('composite transport uses only the explicit route and never falls back', async () => {
  const sends = []
  const fake = (kind, fail = false) => ({
    kind,
    state: 'connected',
    start() {},
    async stop() {},
    async send(input) {
      sends.push([kind, input.content])
      if (fail) throw new Error(`${kind} failed`)
      return { id: kind }
    },
  })
  const composite = new CompositeTransport([fake('github', true), fake('filesystem')], 'github')
  await assert.rejects(() => composite.send({ channel: 'general', content: 'no downgrade' }), /github failed/)
  assert.deepEqual(sends, [['github', 'no downgrade']])
  await composite.send({ route: 'filesystem', channel: 'general', content: 'explicit' })
  assert.deepEqual(sends.at(-1), ['filesystem', 'explicit'])
})

test('ICE policy reports no server for empty STUN and rejects relay without TURN', () => {
  const identity = createDirectIdentity()
  const direct = new DirectSessionManager({
    selfName: 'alice', identity, trustedPeers: new Map(), onMessage() {}, stunServers: [],
  })
  assert.equal(direct.diagnostics.serverContact, 'none')
  assert.throws(
    () => new DirectSessionManager({
      selfName: 'alice', identity, trustedPeers: new Map(), onMessage() {}, icePolicy: 'relay', turnServers: [],
    }),
    /requires at least one TURN server/,
  )
})

test('sealed GitHub rendezvous establishes a direct session without copying SDP codes', async (t) => {
  let wrtc
  try {
    const mod = await import('@roamhq/wrtc')
    wrtc = 'RTCPeerConnection' in mod ? mod : mod.default
  } catch {
    t.skip('@roamhq/wrtc not installed; automatic rendezvous loopback skipped')
    return
  }
  const pair = paired()
  const gh = await startMockGitHub({ tokens: { 'tok-alice': 'alice', 'tok-bob': 'bob' } })
  let aliceService
  let bobService
  let aliceDirect
  let bobDirect
  try {
    const raw = (token) => new GitHubTransport({
      repo: 'team/inbox', token, channels: ['general'], apiBase: gh.url, pollIntervalMs: 5_000,
    })
    const aliceRaw = raw('tok-alice')
    const bobRaw = raw('tok-bob')
    const aliceTransport = new SecureTransport(aliceRaw, 'sealed', new MailboxEnvelopeCodec({
      selfName: 'alice', identity: pair.aliceIdentity, contacts: pair.aliceContacts,
    }))
    const bobTransport = new SecureTransport(bobRaw, 'sealed', new MailboxEnvelopeCodec({
      selfName: 'bob', identity: pair.bobIdentity, contacts: pair.bobContacts,
    }))
    aliceService = new MessengerService({
      transport: aliceTransport, inbox: QuarantineInbox.open(join(pair.root, 'alice-inbox.json')), selfName: 'alice',
    })
    bobService = new MessengerService({
      transport: bobTransport, inbox: QuarantineInbox.open(join(pair.root, 'bob-inbox.json')), selfName: 'bob',
    })
    aliceDirect = new DirectSessionManager({
      selfName: 'alice', identity: pair.aliceIdentity, trustedPeers: () => pair.aliceContacts.trustedPeers(),
      onMessage: (message) => aliceService.intake(message), rtcModule: wrtc, icePolicy: 'strict',
    })
    bobDirect = new DirectSessionManager({
      selfName: 'bob', identity: pair.bobIdentity, trustedPeers: () => pair.bobContacts.trustedPeers(),
      onMessage: (message) => bobService.intake(message), rtcModule: wrtc, icePolicy: 'strict',
    })
    const aliceRendezvous = new RendezvousCoordinator(aliceService, aliceDirect)
    const bobRendezvous = new RendezvousCoordinator(bobService, bobDirect)
    aliceService.setProtocolHandler((message) => aliceRendezvous.handle(message))
    bobService.setProtocolHandler((message) => bobRendezvous.handle(message))
    aliceService.start()
    bobService.start()
    await waitFor(() => aliceTransport.state === 'connected' && bobTransport.state === 'connected')

    await aliceRendezvous.call('bob@laptop', 'github')
    const mailboxIssue = gh.state.issues.find((issue) => issue.title === 'a2a: __mailbox__')
    assert.equal(mailboxIssue?.comments.length, 1, JSON.stringify(gh.state.issues))
    assert.equal(mailboxIssue?.comments[0]?.user?.login, 'alice')
    const deliveredRendezvous = await bobRaw.pollOnce()
    assert.equal(deliveredRendezvous, 1)
    const bobEvent = await waitFor(() => bobRendezvous.recentEvents().at(-1))
    assert.equal(bobEvent.action, 'offer-accepted', bobEvent.error)
    await aliceRaw.pollOnce()
    await waitFor(() => aliceDirect.state === 'connected' && bobDirect.state === 'connected')
    assert.equal(aliceDirect.peerFingerprint, pair.bobIdentity.fingerprint)
    assert.equal(bobDirect.peerFingerprint, pair.aliceIdentity.fingerprint)
  } finally {
    await aliceService?.stop()
    await bobService?.stop()
    await aliceDirect?.close()
    await bobDirect?.close()
    await gh.close()
    rmSync(pair.root, { recursive: true, force: true })
  }
})
