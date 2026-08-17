import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockTeamMcp } from './mock-teammcp-server.mjs'
import { QuarantineInbox } from '../lib/inbox.js'
import { MessengerService } from '../lib/service.js'
import { TeamMcpClient } from '../lib/teammcp-client.js'

function tempInbox() {
  return QuarantineInbox.open(join(mkdtempSync(join(tmpdir(), 'a2a-svc-')), 'inbox.json'))
}

async function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

test('live message flows into quarantine via SSE', async () => {
  const relay = await startMockTeamMcp()
  const inbox = tempInbox()
  let service
  try {
    const alice = await TeamMcpClient.register(relay.url, { name: 'alice' })
    const bob = await TeamMcpClient.register(relay.url, { name: 'bob' })
    const aliceClient = new TeamMcpClient({ baseUrl: relay.url, token: alice.apiKey })
    const bobClient = new TeamMcpClient({ baseUrl: relay.url, token: bob.apiKey })

    const quarantined = []
    service = new MessengerService({
      client: bobClient,
      inbox,
      selfName: 'bob',
      onQuarantined: (m) => quarantined.push(m),
    })
    service.start()
    await waitFor(() => service.connectionState === 'connected')

    await aliceClient.send({ channel: 'general', content: 'align on PRD section 3' })
    await waitFor(() => inbox.pendingCount() === 1)

    assert.equal(quarantined.length, 1)
    assert.equal(quarantined[0].from, 'alice')
    assert.equal(quarantined[0].status, 'pending')
    // Nothing auto-accepted: the message is pending until the user decides.
    assert.equal(inbox.listPending()[0].content, 'align on PRD section 3')
  } finally {
    await service?.stop()
    await relay.close()
  }
})

test('messages sent while offline are recovered on connect and acked', async () => {
  const relay = await startMockTeamMcp()
  const inbox = tempInbox()
  let service
  try {
    const alice = await TeamMcpClient.register(relay.url, { name: 'alice' })
    const bob = await TeamMcpClient.register(relay.url, { name: 'bob' })
    const aliceClient = new TeamMcpClient({ baseUrl: relay.url, token: alice.apiKey })
    const bobClient = new TeamMcpClient({ baseUrl: relay.url, token: bob.apiKey })

    // Bob offline: two messages queue on the relay.
    await aliceClient.send({ channel: 'general', content: 'first' })
    await aliceClient.send({ to: 'bob', content: 'second' })

    service = new MessengerService({ client: bobClient, inbox, selfName: 'bob' })
    service.start()
    await waitFor(() => inbox.pendingCount() === 2)

    // Relay-side inbox must be acked after local storage succeeded.
    await waitFor(async () => (await bobClient.inbox()).length === 0)
  } finally {
    await service?.stop()
    await relay.close()
  }
})

test('dedup: catch-up after live delivery does not duplicate messages', async () => {
  const relay = await startMockTeamMcp()
  const inbox = tempInbox()
  let service
  try {
    const alice = await TeamMcpClient.register(relay.url, { name: 'alice' })
    const bob = await TeamMcpClient.register(relay.url, { name: 'bob' })
    const aliceClient = new TeamMcpClient({ baseUrl: relay.url, token: alice.apiKey })
    const bobClient = new TeamMcpClient({ baseUrl: relay.url, token: bob.apiKey })

    service = new MessengerService({ client: bobClient, inbox, selfName: 'bob' })
    service.start()
    await waitFor(() => service.connectionState === 'connected')

    await aliceClient.send({ channel: 'general', content: 'once only' })
    await waitFor(() => inbox.pendingCount() === 1)

    const added = await service.catchUp() // extra catch-up must not duplicate
    assert.equal(added, 0)
    assert.equal(inbox.pendingCount(), 1)
  } finally {
    await service?.stop()
    await relay.close()
  }
})
