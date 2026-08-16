#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity, identityFingerprint, saveEncryptedIdentity } from './identity.mjs';
import { runDemo } from './demo.mjs';
import { runDoctor } from './doctor.mjs';
import { HttpRelayServer } from './http-relay.mjs';
import { runWorkDemo } from './work-demo.mjs';

const [, , command = 'help', ...args] = process.argv;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  if (command === 'version' || command === '--version') {
    console.log('dsh-a2a-messenger 0.2.0 (frame protocol 0.1, Work Package v1, A2A wire 1.0)');
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
  if (command === 'work-demo') {
    console.log(JSON.stringify(await runWorkDemo(), null, 2));
    return;
  }
  if (command === 'relay-token') {
    const deviceId = option('--device-id');
    if (!deviceId) throw new Error('--device-id is required');
    console.log(JSON.stringify({ deviceId, token: randomBytes(32).toString('base64url') }, null, 2));
    return;
  }
  if (command === 'relay-serve') {
    const credentialPath = resolve(option('--credentials', 'relay-credentials.json'));
    if ((statSync(credentialPath).mode & 0o077) !== 0) throw new Error('relay credential file must not be group/world accessible; use chmod 600');
    const configuration = JSON.parse(readFileSync(credentialPath, 'utf8'));
    if (!Array.isArray(configuration.devices) || configuration.devices.length === 0) throw new Error('relay credentials require a non-empty devices array');
    const host = option('--host', '127.0.0.1');
    const port = Number(option('--port', '8787'));
    const relay = new HttpRelayServer({
      path: resolve(option('--db', 'relay.db')), host, port,
      allowInsecureNetwork: args.includes('--allow-insecure-network'),
    });
    for (const credential of configuration.devices) relay.registerCredential(credential.deviceId, credential.token);
    const listening = await relay.listen();
    console.log(JSON.stringify({ ok: true, url: listening.url, devices: configuration.devices.length, plaintextContent: false }, null, 2));
    await new Promise((resolveSignal) => {
      process.once('SIGINT', resolveSignal);
      process.once('SIGTERM', resolveSignal);
    });
    await relay.close();
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
  console.log(`Usage: dsh-a2a <command>\n\nCommands:\n  init [--dir PATH] [--name NAME]  create encrypted local identity\n  doctor [--identity PATH]         verify runtime and configuration\n  demo                             run local messaging/security demo\n  work-demo                        directly transfer code and a result over HTTP\n  relay-token --device-id UUID     generate one device relay credential\n  relay-serve --credentials FILE   run HTTP+SQLite relay (loopback by default)\n  version                          print versions`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
