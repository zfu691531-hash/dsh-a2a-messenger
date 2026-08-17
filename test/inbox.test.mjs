import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuarantineInbox } from '../lib/inbox.js'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'a2a-inbox-')), 'inbox.json')
}

function msg(id, extra = {}) {
  return { id, from: 'alice', content: `content of ${id}`, ts: Date.now(), ...extra }
}

test('add, dedup, accept and reject transitions', () => {
  const inbox = QuarantineInbox.open(tempFile())
  assert.equal(inbox.add(msg('m1')), 'added')
  assert.equal(inbox.add(msg('m1')), 'duplicate')
  assert.equal(inbox.add(msg('m2')), 'added')
  assert.equal(inbox.pendingCount(), 2)

  const accepted = inbox.accept('m1')
  assert.equal(accepted.status, 'accepted')
  assert.equal(inbox.accept('m1'), undefined) // not pending anymore
  assert.equal(inbox.reject('m2').status, 'rejected')
  assert.equal(inbox.pendingCount(), 0)
})

test('decideAll settles every pending message', () => {
  const inbox = QuarantineInbox.open(tempFile())
  inbox.add(msg('a'))
  inbox.add(msg('b'))
  const affected = inbox.decideAll('accepted')
  assert.equal(affected.length, 2)
  assert.equal(inbox.pendingCount(), 0)
})

test('state survives reopen from disk', () => {
  const file = tempFile()
  const first = QuarantineInbox.open(file)
  first.add(msg('m1'))
  first.add(msg('m2'))
  first.accept('m1')

  const second = QuarantineInbox.open(file)
  assert.equal(second.get('m1').status, 'accepted')
  assert.equal(second.get('m2').status, 'pending')
  assert.equal(second.add(msg('m1')), 'duplicate') // dedup persists across restarts
})

test('oversized content and full inbox are refused', () => {
  const inbox = QuarantineInbox.open(tempFile(), { maxPending: 2, maxContentBytes: 10 })
  assert.equal(inbox.add(msg('big', { content: 'x'.repeat(11) })), 'rejected-too-large')
  assert.equal(inbox.add(msg('m1', { content: 'short' })), 'added')
  assert.equal(inbox.add(msg('m2', { content: 'short' })), 'added')
  assert.equal(inbox.add(msg('m3', { content: 'short' })), 'rejected-inbox-full')
})
