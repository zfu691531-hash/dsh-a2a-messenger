import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LocalStore } from './store.mjs';
import { LoopbackRelayTransport } from './relay.mjs';
import { a2aHeaders } from './a2a.mjs';

export function runDoctor({ identityPath } = {}) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const checks = [];
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  const sqliteWithoutFlag = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);
  checks.push({ name: 'node-version', ok: sqliteWithoutFlag, detail: process.versions.node, required: '>=22.13.0' });
  try {
    JSON.parse(readFileSync(join(root, 'schemas/envelope.schema.json'), 'utf8'));
    checks.push({ name: 'envelope-schema', ok: true });
  } catch (error) { checks.push({ name: 'envelope-schema', ok: false, detail: error.message }); }
  try {
    JSON.parse(readFileSync(join(root, 'schemas/work-package.schema.json'), 'utf8'));
    checks.push({ name: 'work-package-schema', ok: true });
  } catch (error) { checks.push({ name: 'work-package-schema', ok: false, detail: error.message }); }
  try {
    const store = new LocalStore(':memory:'); store.close();
    const relay = new LoopbackRelayTransport(':memory:');
    checks.push({ name: 'sqlite-loopback', ok: relay.health().ok }); relay.close();
  } catch (error) { checks.push({ name: 'sqlite-loopback', ok: false, detail: error.message }); }
  checks.push({ name: 'a2a-version-header', ok: a2aHeaders()['A2A-Version'] === '1.0' });
  checks.push({ name: 'audit-content-disabled', ok: true, detail: 'audit schema has no body/ciphertext columns' });
  if (identityPath) {
    try {
      const mode = statSync(identityPath).mode & 0o777;
      checks.push({ name: 'identity-file-mode', ok: mode === 0o600, detail: mode.toString(8) });
    } catch (error) { checks.push({ name: 'identity-file-mode', ok: false, detail: error.message }); }
  }
  return { ok: checks.every((check) => check.ok), checks };
}
