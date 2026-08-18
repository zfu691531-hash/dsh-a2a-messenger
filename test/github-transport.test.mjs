import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockGitHub } from './mock-github-server.mjs'
import { GitHubTransport, GitHubTransportError } from '../lib/transports/github.js'
import { QuarantineInbox } from '../lib/inbox.js'
import { MessengerService } from '../lib/service.js'

const TOKENS = { 'tok-alice': 'alice', 'tok-bob': 'bob' }

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'a2a-gh-'))
}

function makeTransport(url, token, extra = {}) {
  return new GitHubTransport({
    repo: 'team/inbox',
    token,
    channels: ['general'],
    apiBase: url,
    pollIntervalMs: 5_000,
    backfillMs: 3_600_000,
    ...extra,
  })
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

test('send creates the channel issue and posts a comment', async () => {
  const gh = await startMockGitHub({ tokens: TOKENS })
  try {
    const alice = makeTransport(gh.url, 'tok-alice')
    const receipt = await alice.send({ channel: 'general', content: 'PRD intent v1' })
    assert.match(receipt.id, /^gh-\d+$/)
    assert.equal(gh.state.issues.length, 1)
    assert.equal(gh.state.issues[0].title, 'a2a: general')
    assert.equal(gh.state.issues[0].comments[0].body, 'PRD intent v1')

    // Second send reuses the same issue instead of creating another.
    await alice.send({ channel: 'general', content: 'follow-up' })
    assert.equal(gh.state.issues.length, 1)
    assert.equal(gh.state.issues[0].comments.length, 2)
  } finally {
    await gh.close()
  }
})

test('polling delivers teammate comments but never own ones', async () => {
  const gh = await startMockGitHub({ tokens: TOKENS })
  try {
    const alice = makeTransport(gh.url, 'tok-alice')
    const bob = makeTransport(gh.url, 'tok-bob', {
      cursorFile: join(tempDir(), 'cursor.json'),
    })

    const received = []
    bob.start({ onMessage: (m) => received.push(m) })
    await waitFor(() => bob.state === 'connected')

    await alice.send({ channel: 'general', content: 'from alice' })
    await bob.send({ channel: 'general', content: 'from bob himself' })
    await bob.pollOnce()

    assert.equal(received.length, 1)
    assert.equal(received[0].from, 'alice')
    assert.equal(received[0].channel, 'general')
    assert.equal(received[0].content, 'from alice')

    // Next poll: no repeats (cursor advanced past both comments).
    await bob.pollOnce()
    assert.equal(received.length, 1)
    await bob.stop()
  } finally {
    await gh.close()
  }
})

test('cursor persists across restarts so old messages are not replayed', async () => {
  const gh = await startMockGitHub({ tokens: TOKENS })
  const cursorFile = join(tempDir(), 'cursor.json')
  try {
    const alice = makeTransport(gh.url, 'tok-alice')

    const first = makeTransport(gh.url, 'tok-bob', { cursorFile })
    const firstBatch = []
    first.start({ onMessage: (m) => firstBatch.push(m) })
    await waitFor(() => first.state === 'connected')
    await alice.send({ channel: 'general', content: 'seen by first run' })
    await first.pollOnce()
    assert.equal(firstBatch.length, 1)
    await first.stop()

    const second = makeTransport(gh.url, 'tok-bob', { cursorFile })
    const secondBatch = []
    second.start({ onMessage: (m) => secondBatch.push(m) })
    await waitFor(() => second.state === 'connected')
    await second.pollOnce()
    assert.equal(secondBatch.length, 0) // already consumed in the first run
    await second.stop()
  } finally {
    await gh.close()
  }
})

test('dm sends are refused with a helpful error', async () => {
  const gh = await startMockGitHub({ tokens: TOKENS })
  try {
    const alice = makeTransport(gh.url, 'tok-alice')
    await assert.rejects(
      () => alice.send({ to: 'bob', content: 'psst' }),
      (err) => err instanceof GitHubTransportError && /direct session/.test(err.message),
    )
  } finally {
    await gh.close()
  }
})

test('end to end: github transport feeds the quarantine inbox via the service', async () => {
  const gh = await startMockGitHub({ tokens: TOKENS })
  try {
    const alice = makeTransport(gh.url, 'tok-alice')
    const bobTransport = makeTransport(gh.url, 'tok-bob', {
      cursorFile: join(tempDir(), 'cursor.json'),
    })
    const inbox = QuarantineInbox.open(join(tempDir(), 'inbox.json'))
    const service = new MessengerService({ transport: bobTransport, inbox, selfName: 'bob' })
    service.start()
    await waitFor(() => service.connectionState === 'connected')

    await alice.send({ channel: 'general', content: 'capsule: onboarding goals' })
    await bobTransport.pollOnce()

    assert.equal(inbox.pendingCount(), 1)
    assert.equal(inbox.listPending()[0].status, 'pending') // quarantined, not auto-injected
    await service.stop()
  } finally {
    await gh.close()
  }
})

test('collaborators surface as peers', async () => {
  const gh = await startMockGitHub({ tokens: TOKENS })
  try {
    const alice = makeTransport(gh.url, 'tok-alice')
    const peers = await alice.peers()
    assert.deepEqual(peers.map((p) => p.name).sort(), ['alice', 'bob'])
  } finally {
    await gh.close()
  }
})

test('concurrent first start cannot partition peers across duplicate channel issues', async () => {
  const gh = await startMockGitHub({ tokens: TOKENS, issueListBarrierRounds: 2 })
  const alice = makeTransport(gh.url, 'tok-alice')
  const bob = makeTransport(gh.url, 'tok-bob')
  const aliceGot = []
  const bobGot = []
  try {
    alice.start({ onMessage: (message) => aliceGot.push(message) })
    bob.start({ onMessage: (message) => bobGot.push(message) })
    await waitFor(() => alice.state === 'connected' && bob.state === 'connected')
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(gh.state.issues.filter((issue) => issue.title === 'a2a: general').length, 2)
    assert.equal(gh.state.issues.filter((issue) => issue.title === 'a2a: __mailbox__').length, 2)

    await alice.send({ channel: 'general', content: 'from alice copy' })
    await bob.send({ channel: 'general', content: 'from bob copy' })
    await Promise.all([alice.pollOnce(), bob.pollOnce()])

    assert.deepEqual(aliceGot.map((message) => message.content), ['from bob copy'])
    assert.deepEqual(bobGot.map((message) => message.content), ['from alice copy'])
  } finally {
    await alice.stop()
    await bob.stop()
    await gh.close()
  }
})
