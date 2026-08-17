import test from 'node:test'
import assert from 'node:assert/strict'
import { startMockTeamMcp } from './mock-teammcp-server.mjs'
import { TeamMcpClient, TeamMcpError, normalizeIncoming } from '../lib/teammcp-client.js'

test('normalizeIncoming tolerates field variants and synthesizes ids', () => {
  const a = normalizeIncoming({ id: 'm1', from: 'alice', channel: 'general', content: 'hi', ts: 42 })
  assert.deepEqual(a, { id: 'm1', from: 'alice', channel: 'general', content: 'hi', ts: 42 })

  const b = normalizeIncoming({ sender: 'bob', text: 'yo', timestamp: 7 })
  assert.equal(b.from, 'bob')
  assert.equal(b.content, 'yo')
  assert.equal(b.ts, 7)
  assert.ok(b.id.length > 0)

  assert.equal(normalizeIncoming({ from: 'x' }), undefined)
  assert.equal(normalizeIncoming(null), undefined)
  assert.equal(normalizeIncoming('nope'), undefined)
})

test('register, send, offline inbox and ack round-trip', async () => {
  const relay = await startMockTeamMcp()
  try {
    const alice = await TeamMcpClient.register(relay.url, { name: 'alice', role: 'pm' })
    const bob = await TeamMcpClient.register(relay.url, { name: 'bob', role: 'dev' })
    assert.match(alice.apiKey, /^tmcp_/)

    const aliceClient = new TeamMcpClient({ baseUrl: relay.url, token: alice.apiKey })
    const bobClient = new TeamMcpClient({ baseUrl: relay.url, token: bob.apiKey })

    assert.equal(await aliceClient.health(), true)

    const receipt = await aliceClient.send({ channel: 'general', content: 'PRD v2 ready' })
    assert.ok(receipt.id)

    // Bob was offline: message must land in his relay-side inbox.
    const inbox = await bobClient.inbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].from, 'alice')
    assert.equal(inbox[0].content, 'PRD v2 ready')

    await bobClient.ackInbox()
    assert.equal((await bobClient.inbox()).length, 0)

    const agents = await bobClient.agents()
    assert.deepEqual(agents.map((a) => a.name).sort(), ['alice', 'bob'])
    assert.deepEqual(await bobClient.channels(), ['general'])
  } finally {
    await relay.close()
  }
})

test('requests without a valid token fail with 401', async () => {
  const relay = await startMockTeamMcp()
  try {
    const client = new TeamMcpClient({ baseUrl: relay.url, token: 'tmcp_bogus' })
    await assert.rejects(
      () => client.send({ channel: 'general', content: 'x' }),
      (err) => err instanceof TeamMcpError && err.status === 401,
    )
  } finally {
    await relay.close()
  }
})

test('registration secret is enforced when configured', async () => {
  const relay = await startMockTeamMcp({ registerSecret: 's3cret' })
  try {
    await assert.rejects(
      () => TeamMcpClient.register(relay.url, { name: 'eve' }),
      (err) => err instanceof TeamMcpError && err.status === 403,
    )
    const ok = await TeamMcpClient.register(relay.url, { name: 'alice', secret: 's3cret' })
    assert.match(ok.apiKey, /^tmcp_/)
  } finally {
    await relay.close()
  }
})
