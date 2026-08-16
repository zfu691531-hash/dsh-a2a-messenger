#!/usr/bin/env node
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity, identityFingerprint, saveEncryptedIdentity } from './identity.mjs';
import { runDemo } from './demo.mjs';
import { runDoctor } from './doctor.mjs';

const [, , command = 'help', ...args] = process.argv;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  if (command === 'version' || command === '--version') {
    console.log('dsh-a2a-messenger 0.1.0 (product protocol 0.1, A2A wire 1.0)');
    return;
  }
  if (command === 'doctor') {
    const result = runDoctor({ identityPath: option('--identity') });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === 'demo') {
    console.log(JSON.stringify(await runDemo(), null, 2));
    return;
  }
  if (command === 'init') {
    const dir = resolve(option('--dir', '.a2a'));
    const passphrase = process.env.DSH_A2A_PASSPHRASE;
    if (!passphrase) throw new Error('DSH_A2A_PASSPHRASE is required for non-interactive init');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const identity = createIdentity(option('--name', 'agent'));
    saveEncryptedIdentity(join(dir, 'identity.enc'), identity, passphrase);
    cpSync(join(projectRoot, 'examples/config.example.json'), join(dir, 'config.json'));
    writeFileSync(join(dir, 'README.txt'), 'Private local state. Do not commit this directory.\n', { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, dataDir: dir, agentId: identity.agentId, fingerprint: identityFingerprint(identity) }, null, 2));
    return;
  }
  console.log(`Usage: dsh-a2a <command>\n\nCommands:\n  init [--dir PATH] [--name NAME]  create encrypted local identity\n  doctor [--identity PATH]         verify runtime and configuration\n  demo                             run local 3-agent E2E scenario\n  version                          print versions`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
