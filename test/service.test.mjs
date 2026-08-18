import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockTeamMcp } from './mock-teammcp-server.mjs'
import { QuarantineInbox } from '../lib/inbox.js'
import { MessengerService } from '../lib/service.js'
import { TeamMcpClient } from '../lib/teammcp-client.js'
import { TeamMcpTransport } from '../lib/transports/teammcp.js'

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

async function twoClients(relay) {
  const alice = await TeamMcpClient.register(relay.url, { name: 'alice' })
  const bob = await TeamMcpClient.register(relay.url, { name: 'bob' })
  return {
    aliceClient: new TeamMcpClient({ baseUrl: relay.url, token: alice.apiKey }),
    bobClient: new TeamMcpClient({ baseUrl: relay.url, token: bob.apiKey }),
  }
}

function bobService(bobClient, inbox, extra = {}) {
  const transport = new TeamMcpTransport({ client: bobClient, selfName: 'bob' })
  return {
    transport,
    service: new MessengerService({ transport, inbox, selfName: 'bob', ...extra }),
  }
}

test('teammcp: live message flows into quarantine via SSE', async () => {
  const relay = await startMockTeamMcp()
  const inbox = tempInbox()
  let service
  try {
    const { aliceClient, bobClient } = await twoClients(relay)
    const quarantined = []
    ;({ service } = bobService(bobClient, inbox, { onQuarantined: (m) => quarantined.push(m) }))
    service.start()
    await waitFor(() => service.connectionState === 'connected')

    await aliceClient.send({ channel: 'general', content: 'align on PRD section 3' })
    await waitFor(() => inbox.pendingCount() === 1)

    assert.equal(quarantined.length, 1)
    assert.equal(quarantined[0].from, 'alice')
    assert.equal(quarantined[0].status, 'pending')
    assert.equal(inbox.listPending()[0].content, 'align on PRD section 3')
  } finally {
    await service?.stop()
    await relay.close()
  }
})

test('teammcp: offline messages are recovered on connect and acked', async () => {
  const relay = await startMockTeamMcp()
  const inbox = tempInbox()
  let service
  try {
    const { aliceClient, bobClient } = await twoClients(relay)

    // Bob offline: two messages queue on the relay.
    await aliceClient.send({ channel: 'general', content: 'first' })
    await aliceClient.send({ to: 'bob', content: 'second' })
    ;({ service } = bobService(bobClient, inbox))
    service.start()
    await waitFor(() => inbox.pendingCount() === 2)
    await waitFor(async () => (await bobClient.inbox()).length === 0)
  } finally {
    await service?.stop()
    await relay.close()
  }
})

test('teammcp: catch-up after live delivery does not duplicate messages', async () => {
  const relay = await startMockTeamMcp()
  const inbox = tempInbox()
  let service
  let transport
  try {
    const { aliceClient, bobClient } = await twoClients(relay)
    ;({ service, transport } = bobService(bobClient, inbox))
    service.start()
    await waitFor(() => service.connectionState === 'connected')

    await aliceClient.send({ channel: 'general', content: 'once only' })
    await waitFor(() => inbox.pendingCount() === 1)

    await transport.catchUp() // extra catch-up re-delivers nothing new
    assert.equal(inbox.pendingCount(), 1)
  } finally {
    await service?.stop()
    await relay.close()
  }
})

test('service.intake filters self-echo regardless of transport', () => {
  const inbox = tempInbox()
  const noopTransport = {
    kind: 'noop',
    state: 'idle',
    start() {},
    async stop() {},
    async send() {
      return {}
    },
  }
  const service = new MessengerService({ transport: noopTransport, inbox, selfName: 'bob' })
  service.intake({ id: 'x1', from: 'bob', content: 'my own echo', ts: Date.now() })
  service.intake({ id: 'x2', from: 'alice', content: 'real message', ts: Date.now() })
  assert.equal(inbox.pendingCount(), 1)
  assert.equal(inbox.listPending()[0].from, 'alice')
})
