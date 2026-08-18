import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeCode, encodeCode } from '../lib/direct/codec.js'
import { DirectSessionManager } from '../lib/direct/session.js'

test('connect-code codec round-trips and rejects garbage', () => {
  const payload = { v: 1, role: 'offer', name: 'alice', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }
  const code = encodeCode(payload)
  assert.match(code, /^A2A1-/)
  assert.deepEqual(decodeCode(code), payload)
  assert.deepEqual(decodeCode(`  ${code}  `), payload) // tolerate chat-app whitespace

  assert.equal(decodeCode('not-a-code'), undefined)
  assert.equal(decodeCode('A2A1-!!!!'), undefined)
  assert.equal(
    decodeCode(encodeCode({ v: 1, role: 'weird', name: 'x', sdp: 'y' })),
    undefined,
  )
})

test('direct session loopback: offer/answer codes, P2P delivery, quarantine semantics', async (t) => {
  let wrtc
  try {
    const mod = await import('@roamhq/wrtc')
    wrtc = 'RTCPeerConnection' in mod ? mod : mod.default
  } catch {
    t.skip('@roamhq/wrtc not installed; direct-session loopback skipped')
    return
  }

  const aliceGot = []
  const bobGot = []
  const alice = new DirectSessionManager({
    selfName: 'alice',
    onMessage: (m) => aliceGot.push(m),
    rtcModule: wrtc,
    stunServers: [], // loopback: host candidates are enough
  })
  const bob = new DirectSessionManager({
    selfName: 'bob',
    onMessage: (m) => bobGot.push(m),
    rtcModule: wrtc,
    stunServers: [],
  })

  try {
    const offerCode = await alice.createOffer()
    assert.equal(alice.state, 'waiting-answer')

    const { answerCode } = await bob.accept(offerCode)
    assert.ok(answerCode, 'answering side must return an answer code')
    assert.equal(bob.peerName, 'alice')

    const done = await alice.accept(answerCode)
    assert.equal(done.answerCode, undefined)
    assert.equal(alice.peerName, 'bob')

    const deadline = Date.now() + 15_000
    while ((alice.state !== 'connected' || bob.state !== 'connected') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(alice.state, 'connected')
    assert.equal(bob.state, 'connected')

    alice.send('hello from alice')
    bob.send('hello from bob')
    const msgDeadline = Date.now() + 5_000
    while ((aliceGot.length < 1 || bobGot.length < 1) && Date.now() < msgDeadline) {
      await new Promise((r) => setTimeout(r, 50))
    }

    assert.equal(bobGot[0].from, 'alice')
    assert.equal(bobGot[0].content, 'hello from alice')
    assert.equal(bobGot[0].channel, 'direct')
    assert.equal(aliceGot[0].from, 'bob')

    // Sending after close must fail loudly, not silently drop.
    await alice.close()
    assert.throws(() => alice.send('too late'), /not connected/)
  } finally {
    await alice.close()
    await bob.close()
  }
})
