import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockTeamMcp } from './mock-teammcp-server.mjs'
import { QuarantineInbox } from '../lib/inbox.js'
import { MessengerService } from '../lib/service.js'
import { TeamMcpClient } from '../lib/teammcp-client.js'
import { buildCommandDefs, buildToolDefs, formatInjection, parseTarget } from '../lib/surface.js'

function tempInbox() {
  return QuarantineInbox.open(join(mkdtempSync(join(tmpdir(), 'a2a-surf-')), 'inbox.json'))
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

test('a2a_send tool sends through the relay', async () => {
  const relay = await startMockTeamMcp()
  try {
    const alice = await TeamMcpClient.register(relay.url, { name: 'alice' })
    await TeamMcpClient.register(relay.url, { name: 'bob' })
    const client = new TeamMcpClient({ baseUrl: relay.url, token: alice.apiKey })
    const [send] = buildToolDefs({ client, inbox: tempInbox(), selfName: 'alice' })

    const ok = await send.execute({ target: '@bob', content: 'ping' })
    assert.match(ok, /^Sent to @bob/)
    assert.equal(relay.state.sentLog.length, 1)
    assert.equal(relay.state.sentLog[0].to, 'bob')

    const bad = await send.execute({ target: 'nowhere', content: 'ping' })
    assert.match(bad, /^Invalid target/)
    const empty = await send.execute({ target: '#general', content: '   ' })
    assert.match(empty, /^Refused/)
  } finally {
    await relay.close()
  }
})

test('a2a_inbox_status never exposes message content to the model', async () => {
  const inbox = tempInbox()
  const secret = 'SECRET-PAYLOAD-DO-NOT-LEAK'
  pendingMsg(inbox, 'm1', secret)
  const defs = buildToolDefs({
    client: new TeamMcpClient({ baseUrl: 'http://127.0.0.1:9', token: 'tmcp_x' }),
    inbox,
    selfName: 'bob',
  })
  const status = defs.find((d) => d.name === 'a2a_inbox_status')
  const text = await status.execute({})
  assert.match(text, /1 message\(s\)/)
  assert.match(text, /from alice/)
  assert.ok(!text.includes(secret), 'quarantined content leaked to the model')
})

test('/a2a-accept injects accepted content into the exact agent', async () => {
  const inbox = tempInbox()
  pendingMsg(inbox, 'm1', 'PRD intent: reduce onboarding friction')
  const service = new MessengerService({
    client: new TeamMcpClient({ baseUrl: 'http://127.0.0.1:9', token: 'tmcp_x' }),
    inbox,
    selfName: 'bob',
  })
  const defs = buildCommandDefs({ inbox, service, serverUrl: 'http://relay', agentName: 'bob' })
  const accept = defs.find((d) => d.name === 'a2a-accept')

  const { invocation, injected } = fakeInvocation('m1')
  const result = await accept.handler(invocation)
  assert.equal(result.kind, 'success')
  assert.equal(injected.length, 1)
  assert.match(injected[0].content, /PRD intent: reduce onboarding friction/)
  assert.match(injected[0].content, /accepted by the local user/)
  assert.deepEqual(injected[0].source, { kind: 'plugin', plugin: 'a2a-messenger' })
  assert.equal(inbox.get('m1').status, 'accepted')

  // Second accept of the same id must fail: no double injection.
  const again = await accept.handler(fakeInvocation('m1').invocation)
  assert.equal(again.kind, 'error')
})

test('/a2a-accept all and /a2a-reject work on batches', async () => {
  const inbox = tempInbox()
  pendingMsg(inbox, 'm1')
  pendingMsg(inbox, 'm2')
  pendingMsg(inbox, 'm3')
  const service = new MessengerService({
    client: new TeamMcpClient({ baseUrl: 'http://127.0.0.1:9', token: 'tmcp_x' }),
    inbox,
    selfName: 'bob',
  })
  const defs = buildCommandDefs({ inbox, service, serverUrl: 'http://relay', agentName: 'bob' })
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

test('/a2a-inbox previews content for the user and /a2a-status reports counters', async () => {
  const inbox = tempInbox()
  pendingMsg(inbox, 'm1', 'A very important alignment note about the PRD')
  const service = new MessengerService({
    client: new TeamMcpClient({ baseUrl: 'http://127.0.0.1:9', token: 'tmcp_x' }),
    inbox,
    selfName: 'bob',
  })
  const defs = buildCommandDefs({ inbox, service, serverUrl: 'http://relay', agentName: 'bob' })

  const list = await defs.find((d) => d.name === 'a2a-inbox').handler(fakeInvocation('').invocation)
  assert.equal(list.kind, 'success')
  assert.match(list.text, /alignment note/) // the human IS allowed to see content

  const status = await defs.find((d) => d.name === 'a2a-status').handler(fakeInvocation('').invocation)
  assert.match(status.text, /pending messages: 1/)
})

test('formatInjection includes provenance and the non-instruction caution', () => {
  const inbox = tempInbox()
  const m = pendingMsg(inbox, 'm1', 'hello')
  const text = formatInjection(m)
  assert.match(text, /From: alice/)
  assert.match(text, /#general/)
  assert.match(text, /not as instructions/)
})
