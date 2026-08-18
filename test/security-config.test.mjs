import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTransport, parseTrustedPeers } from '../lib/index.js'
import { createDirectIdentity } from '../lib/direct/identity.js'

test('direct-only transport starts without GitHub or TeamMCP configuration', async () => {
  const transport = buildTransport({ transport: 'none' }, '.')
  assert.equal(transport.kind, 'none')
  assert.equal(transport.state, 'idle')
  assert.deepEqual(await transport.peers(), [])
  await assert.rejects(
    () => transport.send({ channel: 'general', content: 'x' }),
    /async mailbox transport is disabled/,
  )
})

test('trusted peer configuration binds one name to one fingerprint', () => {
  const alice = createDirectIdentity()
  const bob = createDirectIdentity()
  const parsed = parseTrustedPeers([
    `alice=${alice.fingerprint}`,
    `bob=${bob.fingerprint}`,
  ])
  assert.equal(parsed.get(alice.fingerprint), 'alice')
  assert.equal(parsed.get(bob.fingerprint), 'bob')

  assert.throws(() => parseTrustedPeers(['bad-entry']), /invalid trustedPeers/)
  assert.throws(
    () => parseTrustedPeers([`alice=${alice.fingerprint}`, `mallory=${alice.fingerprint}`]),
    /multiple names/,
  )
  assert.throws(
    () => parseTrustedPeers([`alice=${alice.fingerprint}`, `alice=${bob.fingerprint}`]),
    /multiple fingerprints/,
  )
})
