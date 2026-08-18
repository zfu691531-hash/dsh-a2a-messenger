import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDirectIdentity,
  openDirectIdentity,
  signText,
  verifyText,
} from '../lib/direct/identity.js'

test('identity is stable on disk and signatures verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-identity-'))
  const file = join(dir, 'identity.json')
  const first = openDirectIdentity(file)
  const second = openDirectIdentity(file)
  assert.deepEqual(second, first)
  assert.match(first.fingerprint, /^ed25519:[A-Za-z0-9_-]{43}$/)
  const signature = signText(first, 'hello')
  assert.equal(verifyText(first.publicKey, 'hello', signature), true)
  assert.equal(verifyText(first.publicKey, 'tampered', signature), false)
})

test('corrupt or mismatched identity fails closed instead of rotating silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-identity-bad-'))
  const file = join(dir, 'identity.json')
  writeFileSync(file, 'not-json', 'utf8')
  assert.throws(() => openDirectIdentity(file), /not valid JSON/)

  const one = createDirectIdentity()
  const two = createDirectIdentity()
  writeFileSync(
    file,
    JSON.stringify({ version: 1, publicKey: one.publicKey, privateKey: two.privateKey }),
    'utf8',
  )
  assert.throws(() => openDirectIdentity(file), /mismatch/)
  assert.ok(readFileSync(file, 'utf8').includes(two.privateKey))
})
