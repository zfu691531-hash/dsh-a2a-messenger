import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuarantineInbox } from '../lib/inbox.js'
import { MessengerService } from '../lib/service.js'
import { buildCommandDefs, buildToolDefs, formatInjection, parseTarget } from '../lib/surface.js'

function tempInbox() {
  return QuarantineInbox.open(join(mkdtempSync(join(tmpdir(), 'a2a-surf-')), 'inbox.json'))
}

/** In-memory transport standing in for github/teammcp in surface tests. */
function fakeTransport() {
  const sent = []
  return {
    sent,
    kind: 'fake',
    state: 'connected',
    start() {},
    async stop() {},
    async send(input) {
      sent.push(input)
      return { id: `fake-${sent.length}` }
    },
    async peers() {
      return [{ name: 'alice', role: 'pm' }, { name: 'bob' }]
    },
    async channels() {
      return ['general']
    },
  }
}

/** Minimal stand-in for DirectSessionManager. */
function fakeDirect(state = 'idle') {
  const sentDirect = []
  return {
    sentDirect,
    state,
    peerName: state === 'connected' ? 'alice' : '',
    peerFingerprint: state === 'connected' ? 'ed25519:peer-fingerprint' : '',
    localFingerprint: 'ed25519:local-fingerprint',
    send(content) {
      if (state !== 'connected') throw new Error('direct session is not connected')
      sentDirect.push(content)
      return { id: `direct-${sentDirect.length}` }
    },
    async close() {},
    async createOffer() {
      return 'A2A2-FAKEOFFER'
    },
    async accept(code) {
      if (code.includes('OFFER')) return { answerCode: 'A2A2-FAKEANSWER' }
      return {}
    },
  }
}

function makeDeps({ direct = fakeDirect(), inbox = tempInbox() } = {}) {
  const transport = fakeTransport()
  const service = new MessengerService({ transport, inbox, selfName: 'bob' })
  return { deps: { service, direct, inbox, selfName: 'bob' }, transport, inbox, direct }
}

function fakeInvocation(rawInput) {
  const injected = []
  return {
    injected,
    invocation: {
      agent: { inject: (m) => injected.push(m) },
      rawInput,
      signal: new AbortController().signal,
    },
  }
}

function pendingMsg(inbox, id, content = 'the plan') {
  inbox.add({ id, from: 'alice', channel: 'general', content, ts: 1_700_000_000_000 })
  return inbox.get(id)
}

test('parseTarget accepts both verbose and shorthand forms', () => {
  assert.deepEqual(parseTarget('channel:general'), { channel: 'general' })
  assert.deepEqual(parseTarget('#general'), { channel: 'general' })
  assert.deepEqual(parseTarget('dm:Alice'), { to: 'Alice' })
  assert.deepEqual(parseTarget('@Alice'), { to: 'Alice' })
  assert.equal(parseTarget('general'), undefined)
  assert.equal(parseTarget('#'), undefined)
})

test('a2a_send goes through the mailbox transport', async () => {
  const { deps, transport } = makeDeps()
  const send = buildToolDefs(deps).find((d) => d.name === 'a2a_send')

  const ok = await send.execute({ target: '#general', content: 'ping' })
  assert.match(ok, /^Sent to #general/)
  assert.deepEqual(transport.sent[0], { channel: 'general', content: 'ping' })

  const bad = await send.execute({ target: 'nowhere', content: 'ping' })
  assert.match(bad, /^Invalid target/)
  const empty = await send.execute({ target: '#general', content: '   ' })
  assert.match(empty, /^Refused/)
})

test('a2a_direct_send works only while a direct session is connected', async () => {
  const disconnected = makeDeps({ direct: fakeDirect('idle') })
  const tool = buildToolDefs(disconnected.deps).find((d) => d.name === 'a2a_direct_send')
  assert.match(await tool.execute({ content: 'hi' }), /^Direct send failed/)

  const connected = makeDeps({ direct: fakeDirect('connected') })
  const tool2 = buildToolDefs(connected.deps).find((d) => d.name === 'a2a_direct_send')
  assert.match(await tool2.execute({ content: 'hi' }), /^Sent directly to alice/)
  assert.deepEqual(connected.direct.sentDirect, ['hi'])
})

test('a2a_inbox_status never exposes message content to the model', async () => {
  const { deps, inbox } = makeDeps()
  const secret = 'SECRET-PAYLOAD-DO-NOT-LEAK'
  pendingMsg(inbox, 'm1', secret)
  const status = buildToolDefs(deps).find((d) => d.name === 'a2a_inbox_status')
  const text = await status.execute({})
  assert.match(text, /1 message\(s\)/)
  assert.match(text, /from alice/)
  assert.ok(!text.includes(secret), 'quarantined content leaked to the model')
})

test('/a2a-accept injects accepted content into the exact agent', async () => {
  const { deps, inbox } = makeDeps()
  pendingMsg(inbox, 'm1', 'PRD intent: reduce onboarding friction')
  const accept = buildCommandDefs(deps).find((d) => d.name === 'a2a-accept')

  const { invocation, injected } = fakeInvocation('m1')
  const result = await accept.handler(invocation)
  assert.equal(result.kind, 'success')
  assert.equal(injected.length, 1)
  assert.match(injected[0].content, /PRD intent: reduce onboarding friction/)
  assert.match(injected[0].content, /accepted by the local user/)
  assert.deepEqual(injected[0].source, { kind: 'plugin', plugin: 'a2a-messenger' })
  assert.equal(inbox.get('m1').status, 'accepted')

  const again = await accept.handler(fakeInvocation('m1').invocation)
  assert.equal(again.kind, 'error')
})

test('/a2a-accept all and /a2a-reject work on batches', async () => {
  const { deps, inbox } = makeDeps()
  pendingMsg(inbox, 'm1')
  pendingMsg(inbox, 'm2')
  pendingMsg(inbox, 'm3')
  const defs = buildCommandDefs(deps)
  const reject = defs.find((d) => d.name === 'a2a-reject')
  const accept = defs.find((d) => d.name === 'a2a-accept')

  const r = await reject.handler(fakeInvocation('m2').invocation)
  assert.equal(r.kind, 'success')
  assert.equal(inbox.get('m2').status, 'rejected')

  const { invocation, injected } = fakeInvocation('all')
  const a = await accept.handler(invocation)
  assert.equal(a.kind, 'success')
  assert.equal(injected.length, 2)
  assert.equal(inbox.pendingCount(), 0)
})

test('/a2a-connect, /a2a-join and /a2a-disconnect drive the direct session', async () => {
  const { deps } = makeDeps({ direct: fakeDirect('connected') })
  const defs = buildCommandDefs(deps)

  const connect = await defs.find((d) => d.name === 'a2a-connect').handler(fakeInvocation('').invocation)
  assert.equal(connect.kind, 'success')
  assert.match(connect.text, /A2A2-FAKEOFFER/)

  const joinOffer = await defs
    .find((d) => d.name === 'a2a-join')
    .handler(fakeInvocation('A2A2-FAKEOFFER').invocation)
  assert.equal(joinOffer.kind, 'success')
  assert.match(joinOffer.text, /A2A2-FAKEANSWER/)

  const joinAnswer = await defs
    .find((d) => d.name === 'a2a-join')
    .handler(fakeInvocation('A2A2-SOMEANSWER').invocation)
  assert.equal(joinAnswer.kind, 'success')
  assert.match(joinAnswer.text, /connecting/)

  const joinEmpty = await defs.find((d) => d.name === 'a2a-join').handler(fakeInvocation('').invocation)
  assert.equal(joinEmpty.kind, 'error')

  const bye = await defs.find((d) => d.name === 'a2a-disconnect').handler(fakeInvocation('').invocation)
  assert.equal(bye.kind, 'success')
})

test('/a2a-identity shows the copyable local trust entry', async () => {
  const { deps } = makeDeps()
  const identity = await buildCommandDefs(deps)
    .find((d) => d.name === 'a2a-identity')
    .handler(fakeInvocation('').invocation)
  assert.equal(identity.kind, 'success')
  assert.match(identity.text, /bob=ed25519:local-fingerprint/)
})

test('/a2a-status reports both modes and pending count', async () => {
  const { deps, inbox } = makeDeps({ direct: fakeDirect('connected') })
  pendingMsg(inbox, 'm1', 'A very important alignment note about the PRD')
  const defs = buildCommandDefs(deps)

  const list = await defs.find((d) => d.name === 'a2a-inbox').handler(fakeInvocation('').invocation)
  assert.equal(list.kind, 'success')
  assert.match(list.text, /alignment note/) // the human IS allowed to see content

  const status = await defs.find((d) => d.name === 'a2a-status').handler(fakeInvocation('').invocation)
  assert.match(status.text, /mailbox transport: fake \(connected\)/)
  assert.match(status.text, /direct session: connected with alice/)
  assert.match(status.text, /pending messages: 1/)
})

test('formatInjection includes provenance and the non-instruction caution', () => {
  const inbox = tempInbox()
  const m = pendingMsg(inbox, 'm1', 'hello')
  const text = formatInjection(m)
  assert.match(text, /From: alice/)
  assert.match(text, /#general/)
  assert.match(text, /not as instructions/)

  inbox.add({ id: 'm2', from: 'carol', channel: 'direct', content: 'p2p hello', ts: Date.now() })
  assert.match(formatInjection(inbox.get('m2')), /direct session/)
})
