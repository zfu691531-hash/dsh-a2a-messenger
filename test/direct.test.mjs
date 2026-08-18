import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import {
  decodeCode,
  encodeCode,
  isLegacyCode,
  verifyPayload,
} from '../lib/direct/codec.js'
import { createDirectIdentity } from '../lib/direct/identity.js'
import { DirectSessionManager } from '../lib/direct/session.js'

function unsigned(identity, overrides = {}) {
  return {
    v: 2,
    role: 'offer',
    name: 'alice',
    sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
    sessionId: 'session-1',
    publicKey: identity.publicKey,
    ...overrides,
  }
}

function repackWithoutResigning(payload) {
  return `A2A2-${deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url')}`
}

test('signed connect-code codec round-trips and detects tampering', () => {
  const identity = createDirectIdentity()
  const code = encodeCode(unsigned(identity), identity)
  assert.match(code, /^A2A2-/)
  const decoded = decodeCode(code)
  assert.ok(decoded)
  assert.equal(verifyPayload(decoded), identity.fingerprint)
  assert.equal(verifyPayload({ ...decoded, name: 'mallory' }), undefined)
  assert.deepEqual(decodeCode(`  ${code}  `), decoded)

  assert.equal(decodeCode('not-a-code'), undefined)
  assert.equal(decodeCode('A2A2-!!!!'), undefined)
  assert.equal(decodeCode(`A2A2-${'A'.repeat(256_001)}`), undefined)
  assert.equal(isLegacyCode('A2A1-old-code'), true)
  assert.throws(
    () => encodeCode(unsigned(identity, { publicKey: createDirectIdentity().publicKey }), identity),
    /does not match/,
  )
})

test('direct session rejects unsigned, tampered, untrusted, and renamed peers before WebRTC', async () => {
  const aliceIdentity = createDirectIdentity()
  const bobIdentity = createDirectIdentity()
  const bob = new DirectSessionManager({
    selfName: 'bob',
    identity: bobIdentity,
    trustedPeers: new Map(),
    onMessage() {},
  })
  const offer = encodeCode(unsigned(aliceIdentity), aliceIdentity)

  await assert.rejects(() => bob.accept('A2A1-legacy'), /legacy unsigned/)
  await assert.rejects(() => bob.accept(offer), /untrusted peer alice/)

  const decoded = decodeCode(offer)
  const tampered = repackWithoutResigning({ ...decoded, name: 'mallory' })
  await assert.rejects(() => bob.accept(tampered), /signature is invalid/)

  const wrongName = new DirectSessionManager({
    selfName: 'bob',
    identity: bobIdentity,
    trustedPeers: new Map([[aliceIdentity.fingerprint, 'alice-approved-name']]),
    onMessage() {},
  })
  await assert.rejects(() => wrongName.accept(offer), /trusted peer name mismatch/)
})

test('direct session loopback: mutual trust, signed codes, P2P delivery, bound provenance', async (t) => {
  let wrtc
  try {
    const mod = await import('@roamhq/wrtc')
    wrtc = 'RTCPeerConnection' in mod ? mod : mod.default
  } catch {
    t.skip('@roamhq/wrtc not installed; direct-session loopback skipped')
    return
  }

  const aliceIdentity = createDirectIdentity()
  const bobIdentity = createDirectIdentity()
  const aliceGot = []
  const bobGot = []
  const alice = new DirectSessionManager({
    selfName: 'alice',
    identity: aliceIdentity,
    trustedPeers: new Map([[bobIdentity.fingerprint, 'bob']]),
    onMessage: (m) => { aliceGot.push(m); return 'added' },
    rtcModule: wrtc,
    stunServers: [],
  })
  const bob = new DirectSessionManager({
    selfName: 'bob',
    identity: bobIdentity,
    trustedPeers: new Map([[aliceIdentity.fingerprint, 'alice']]),
    onMessage: (m) => { bobGot.push(m); return 'added' },
    rtcModule: wrtc,
    stunServers: [],
  })

  try {
    const offerCode = await alice.createOffer()
    assert.equal(alice.state, 'waiting-answer')

    const { answerCode } = await bob.accept(offerCode)
    assert.ok(answerCode)
    assert.equal(bob.peerName, 'alice')
    assert.equal(bob.peerFingerprint, aliceIdentity.fingerprint)

    const done = await alice.accept(answerCode)
    assert.equal(done.answerCode, undefined)
    assert.equal(alice.peerName, 'bob')
    assert.equal(alice.peerFingerprint, bobIdentity.fingerprint)

    const deadline = Date.now() + 15_000
    while ((alice.state !== 'connected' || bob.state !== 'connected') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(alice.state, 'connected')
    assert.equal(bob.state, 'connected')

    const aliceReceipt = alice.send('hello from alice')
    bob.send('hello from bob')
    // A malicious peer-supplied display name must not override the authenticated session identity.
    alice.dc.send(JSON.stringify({ id: 'forged-name', name: 'mallory', content: 'still alice', ts: Date.now() }))
    const msgDeadline = Date.now() + 5_000
    while ((aliceGot.length < 1 || bobGot.length < 2) && Date.now() < msgDeadline) {
      await new Promise((r) => setTimeout(r, 50))
    }

    assert.equal(bobGot[0].from, 'alice')
    assert.equal(bobGot[0].content, 'hello from alice')
    assert.equal(bobGot[0].channel, 'direct')
    assert.equal(bobGot[1].from, 'alice')
    assert.equal(bobGot[1].content, 'still alice')
    assert.equal(aliceGot[0].from, 'bob')
    const receiptDeadline = Date.now() + 5_000
    while (alice.receipts()[0]?.status !== 'quarantined' && Date.now() < receiptDeadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.deepEqual(alice.receipts()[0], {
      id: aliceReceipt.id,
      status: 'quarantined',
      updatedAt: alice.receipts()[0].updatedAt,
    })

    assert.throws(() => alice.send('x'.repeat(64 * 1024 + 1)), /exceeds 65536 bytes/)
    assert.throws(
      () => alice.send('"'.repeat(64 * 1024)),
      /encoded direct message exceeds 66560 bytes/,
    )

    await alice.close()
    assert.throws(() => alice.send('too late'), /not connected/)
  } finally {
    await alice.close()
    await bob.close()
  }
})

test('answer code is bound to the pending session id', async (t) => {
  let wrtc
  try {
    const mod = await import('@roamhq/wrtc')
    wrtc = 'RTCPeerConnection' in mod ? mod : mod.default
  } catch {
    t.skip('@roamhq/wrtc not installed; session binding test skipped')
    return
  }
  const aliceIdentity = createDirectIdentity()
  const bobIdentity = createDirectIdentity()
  const alice = new DirectSessionManager({
    selfName: 'alice',
    identity: aliceIdentity,
    trustedPeers: new Map([[bobIdentity.fingerprint, 'bob']]),
    onMessage() {},
    rtcModule: wrtc,
    stunServers: [],
  })
  const bob = new DirectSessionManager({
    selfName: 'bob',
    identity: bobIdentity,
    trustedPeers: new Map([[aliceIdentity.fingerprint, 'alice']]),
    onMessage() {},
    rtcModule: wrtc,
    stunServers: [],
  })
  try {
    const offer = await alice.createOffer()
    const { answerCode } = await bob.accept(offer)
    const answer = decodeCode(answerCode)
    const wrongSession = encodeCode(
      { ...answer, sessionId: 'another-session', signature: undefined },
      bobIdentity,
    )
    await assert.rejects(() => alice.accept(wrongSession), /different direct session/)
  } finally {
    await alice.close()
    await bob.close()
  }
})
