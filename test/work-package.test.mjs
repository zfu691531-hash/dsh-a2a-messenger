import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AgentNode } from '../src/agent.mjs';
import { ConversationController, installMembershipCommit } from '../src/conversation.mjs';
import { canonical, sha256 } from '../src/crypto.mjs';
import { HttpRelayServer, HttpRelayTransport } from '../src/http-relay.mjs';
import { addDevice, createIdentity, identityFingerprint, publicDevice, revokeDevice } from '../src/identity.mjs';
import { LocalApprovalBroker, LocalPolicy } from '../src/policy.mjs';
import { validateFrame } from '../src/protocol.mjs';
import { LoopbackRelayTransport } from '../src/relay.mjs';
import {
  materializeWorkPackage as writeWorkPackage, prepareWorkPackage,
  validateWorkPackageChunk, validateWorkPackageManifest, workPackageDestination,
} from '../src/work-package.mjs';

function installPair(aliceNode, bobNode, alice, bob) {
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob)], { kind: 'direct' });
  const commit = controller.commit();
  const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
  aliceNode.installConversation(installMembershipCommit(null, commit, alice, alice.devices[0], trust));
  bobNode.installConversation(installMembershipCommit(null, commit, bob, bob.devices[0], trust));
  return commit;
}

function sourceTree(dir) {
  const root = join(dir, 'source');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.mjs'), 'export const marker = "DIRECT-CODE-SECRET";\n');
  writeFileSync(join(root, 'README.md'), '# transferred directly\n');
  const binary = randomBytes(140 * 1024);
  writeFileSync(join(root, 'src', 'fixture.bin'), binary);
  return { root, binary };
}

test('a Work Package transfers a code directory, stays encrypted, and materializes only after approval', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-package-'));
  const relay = new LoopbackRelayTransport(join(dir, 'relay.db'));
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const approvalBroker = new LocalApprovalBroker();
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({
    identity: bob, relay, storePath: join(dir, 'bob.db'),
    policy: new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: true }),
    approvalVerifier: approvalBroker.verifier(),
  });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = sourceTree(dir);

  const sent = await aliceNode.sendWorkPackage(commit.conversationId, {
    sourcePath: source.root, title: 'Review this change', instructions: 'Run tests and return the edited files.',
  });
  assert.equal(sent.state, 'published');
  assert.equal(sent.fileCount, 3);
  assert.ok(sent.messageCount >= 5);
  await bobNode.sync(100);
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'ready');
  const persistedChunks = bobNode.store.db.prepare("SELECT inner_json FROM inbox WHERE inner_json LIKE '%work.package.chunk%'").all();
  assert.ok(persistedChunks.length > 0);
  assert.equal(persistedChunks.some((row) => JSON.parse(row.inner_json).payload.data !== undefined), false);
  assert.equal(relay.rawFrames().join('\n').includes('DIRECT-CODE-SECRET'), false);
  const outputRoot = join(dir, 'received');
  assert.throws(() => bobNode.materializeWorkPackage(sent.packageId, outputRoot), /not_approved/);
  bobNode.approveWorkPackage(sent.packageId, approvalBroker.issue(bobNode.store.task(sent.taskId)));
  const materialized = bobNode.materializeWorkPackage(sent.packageId, outputRoot);
  assert.equal(readFileSync(join(materialized, 'src', 'index.mjs'), 'utf8').includes('DIRECT-CODE-SECRET'), true);
  assert.deepEqual(readFileSync(join(materialized, 'src', 'fixture.bin')), source.binary);
  assert.equal(statSync(join(materialized, 'src', 'index.mjs')).mode & 0o111, 0);
  assert.equal(bobNode.store.workPackageChunks(sent.packageId).length, 0);
});

test('offline Work Package frames retry and receiver restart resumes staged chunks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-restart-'));
  const relay = new LoopbackRelayTransport(join(dir, 'relay.db'));
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const policy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobPath = join(dir, 'bob.db');
  let bobNode = new AgentNode({ identity: bob, relay, storePath: bobPath, policy });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = sourceTree(dir);

  relay.setOnline(false);
  const sent = await aliceNode.sendWorkPackage(commit.conversationId, { sourcePath: source.root, title: 'Offline package' });
  assert.equal(sent.state, 'queued');
  relay.setOnline(true);
  assert.equal(await aliceNode.flushOutbox(), sent.messageCount);
  assert.equal((await bobNode.sync(1)).length, 1);
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'staging');
  bobNode.close();
  bobNode = new AgentNode({ identity: bob, relay, storePath: bobPath, policy });
  await bobNode.sync(100);
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'ready');
  bobNode.approveWorkPackage(sent.packageId);
  const materialized = bobNode.materializeWorkPackage(sent.packageId, join(dir, 'restored'));
  assert.deepEqual(readFileSync(join(materialized, 'src', 'fixture.bin')), source.binary);
});

test('a result directory returns over the same Work Package contract', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-result-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const alicePolicy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const bobPolicy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db'), policy: alicePolicy });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'bob.db'), policy: bobPolicy });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const resultDir = join(dir, 'result'); mkdirSync(resultDir);
  writeFileSync(join(resultDir, 'answer.txt'), 'review complete');
  const requested = await aliceNode.sendWorkPackage(commit.conversationId, { title: 'Please review' });
  await bobNode.sync();

  const returned = await bobNode.sendWorkResult(commit.conversationId, {
    taskId: requested.taskId, sourcePath: resultDir, title: 'Review result', instructions: 'Tests passed.',
  });
  await aliceNode.sync();
  assert.equal(aliceNode.store.workPackage(returned.packageId).kind, 'result');
  aliceNode.approveWorkPackage(returned.packageId);
  const output = aliceNode.materializeWorkPackage(returned.packageId, join(dir, 'answers'));
  assert.equal(readFileSync(join(output, 'answer.txt'), 'utf8'), 'review complete');
});

test('unsafe paths, symlinks, and corrupt chunks are rejected before materialization', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-hostile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const safe = join(dir, 'safe'); mkdirSync(safe); writeFileSync(join(safe, 'a.txt'), 'safe');
  symlinkSync(join(safe, 'a.txt'), join(safe, 'link.txt'));
  assert.throws(() => prepareWorkPackage({ sourcePath: safe, title: 'bad' }), /symlink_rejected/);

  rmSync(join(safe, 'link.txt'));
  const prepared = prepareWorkPackage({ sourcePath: safe, title: 'valid' });
  const hostile = structuredClone(prepared.manifest);
  hostile.files[0].path = '../escape.txt';
  const { manifestHash, ...unsigned } = hostile;
  hostile.manifestHash = sha256(canonical(unsigned));
  assert.throws(() => validateWorkPackageManifest(hostile), /path_unsafe/);

  const corrupt = { ...prepared.chunks[0], data: Buffer.from('evil').toString('base64'), byteLength: 4 };
  assert.throws(() => validateWorkPackageChunk(corrupt, prepared.manifest), /chunk_length_invalid|chunk_hash_mismatch/);
  assert.equal(existsSync(join(dir, 'escape.txt')), false);
});

test('HTTP relay authenticates device mailboxes and carries only encrypted frames', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-http-relay-'));
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const aliceToken = randomBytes(32).toString('base64url');
  const bobToken = randomBytes(32).toString('base64url');
  const server = new HttpRelayServer({ path: join(dir, 'relay.db') });
  server.registerCredential(alice.devices[0].deviceId, aliceToken);
  server.registerCredential(bob.devices[0].deviceId, bobToken);
  const listening = await server.listen();
  const aliceTransport = new HttpRelayTransport({ baseUrl: listening.url, deviceId: alice.devices[0].deviceId, token: aliceToken });
  const bobTransport = new HttpRelayTransport({ baseUrl: listening.url, deviceId: bob.devices[0].deviceId, token: bobToken });
  const aliceNode = new AgentNode({ identity: alice, relay: aliceTransport, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({ identity: bob, relay: bobTransport, storePath: join(dir, 'bob.db') });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(async () => { aliceNode.close(); bobNode.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });

  const sent = await aliceNode.send(commit.conversationId, { type: 'chat.message', payload: { text: 'HTTP-RELAY-SECRET' } });
  assert.equal(sent.state, 'published');
  const noncanonical = { ...sent.frame, expiresAt: new Date(Date.now() + 60_000).toUTCString() };
  assert.throws(() => validateFrame(noncanonical), /invalid_frame_time/);
  assert.equal((await bobNode.sync())[0].duplicate, false);
  assert.equal(server.relay.rawFrames().join('\n').includes('HTTP-RELAY-SECRET'), false);
  const credentialDump = JSON.stringify(server.credentialRows());
  assert.equal(credentialDump.includes(aliceToken), false);
  assert.equal(credentialDump.includes(bobToken), false);
  await assert.rejects(aliceTransport.pull(bob.devices[0].deviceId), /mailbox_mismatch/);

  const forged = { ...sent.frame, senderDeviceId: bob.devices[0].deviceId };
  const response = await fetch(`${listening.url}/v1/frames`, {
    method: 'POST', headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(forged),
  });
  assert.equal(response.status, 403);
  const unregistered = { ...sent.frame, recipientDeviceIds: [randomUUID()] };
  const unregisteredResponse = await fetch(`${listening.url}/v1/frames`, {
    method: 'POST', headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(unregistered),
  });
  assert.equal(unregisteredResponse.status, 403);
  const oversizedPull = await fetch(`${listening.url}/v1/mailbox?limit=1000`, {
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(oversizedPull.status, 400);
  assert.equal((await fetch(`${listening.url}/v1/health`)).status, 200);
  assert.throws(() => server.registerCredential('a'.repeat(36), randomBytes(32).toString('base64url')), /invalid_device_id/);
  assert.throws(() => server.registerCredential(alice.devices[0].deviceId, 'REPLACE_ME'), /relay_token_invalid/);
  server.revokeCredential(bob.devices[0].deviceId);
  await assert.rejects(bobTransport.pull(bob.devices[0].deviceId), /relay_auth_failed/);
});

test('a sibling device cannot inject chunks into the originating device Work Package', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-sender-binding-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const aliceSecond = addDevice(alice, 'second'); const bob = createIdentity('Bob');
  const policy = () => new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const nodes = [
    new AgentNode({ identity: alice, device: alice.devices[0], relay, policy: policy(), storePath: join(dir, 'alice-primary.db') }),
    new AgentNode({ identity: alice, device: aliceSecond, relay, policy: policy(), storePath: join(dir, 'alice-second.db') }),
    new AgentNode({ identity: bob, relay, policy: policy(), storePath: join(dir, 'bob.db') }),
  ];
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(alice, aliceSecond), publicDevice(bob)], { kind: 'group' });
  const commit = controller.commit();
  const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
  nodes[0].installConversation(installMembershipCommit(null, commit, alice, alice.devices[0], trust));
  nodes[1].installConversation(installMembershipCommit(null, commit, alice, aliceSecond, trust));
  nodes[2].installConversation(installMembershipCommit(null, commit, bob, bob.devices[0], trust));
  t.after(() => { nodes.forEach((node) => node.close()); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = join(dir, 'one.txt'); writeFileSync(source, 'alice-content');
  const prepared = prepareWorkPackage({ sourcePath: source, title: 'Sender-bound' });
  await nodes[0].send(commit.conversationId, {
    type: 'task.proposal', payload: prepared.manifest,
    capabilityIntent: { taskId: prepared.manifest.taskId, capability: 'work.package', descriptor: { id: 'work.package', version: '1', risk: 'untrusted-content' } },
  });
  const maliciousBytes = Buffer.from('carol-content');
  const injected = {
    ...prepared.chunks[0], byteLength: maliciousBytes.length,
    sha256: sha256(maliciousBytes), data: maliciousBytes.toString('base64'),
  };
  await nodes[1].send(commit.conversationId, { type: 'work.package.chunk', payload: injected });
  await nodes[0].send(commit.conversationId, { type: 'work.package.chunk', payload: prepared.chunks[0] });
  const received = await nodes[2].sync();
  assert.equal(received.some((item) => item.rejected), true);
  assert.equal(nodes[2].store.workPackage(prepared.manifest.packageId).status, 'ready');
  assert.equal(nodes[2].store.workPackageChunks(prepared.manifest.packageId).length, 1);
  assert.deepEqual(Buffer.from(nodes[2].store.workPackageChunks(prepared.manifest.packageId)[0].data_blob), Buffer.from('alice-content'));
});

test('revoking the exact origin device blocks pending Work Package materialization', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-device-revocation-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const aliceSecond = addDevice(alice, 'second'); const bob = createIdentity('Bob');
  const policy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'bob.db'), policy });
  const controller = new ConversationController(bob, [publicDevice(bob), publicDevice(alice), publicDevice(alice, aliceSecond)], { kind: 'group' });
  const genesis = controller.commit();
  const trust = { expectedControllerAgentId: bob.agentId, expectedControllerFingerprint: identityFingerprint(bob) };
  aliceNode.installConversation(installMembershipCommit(null, genesis, alice, alice.devices[0], trust));
  bobNode.installConversation(installMembershipCommit(null, genesis, bob, bob.devices[0], trust));
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });

  const source = join(dir, 'pending.txt'); writeFileSync(source, 'pending-content');
  const sent = await aliceNode.sendWorkPackage(genesis.conversationId, { sourcePath: source, title: 'Pending device-bound package' });
  await bobNode.sync(16);
  bobNode.approveWorkPackage(sent.packageId);
  const next = controller.revokeMemberDevice(bob.agentId, revokeDevice(alice, alice.devices[0].deviceId));
  bobNode.installConversation(installMembershipCommit(bobNode.conversations.get(genesis.conversationId), next, bob));
  assert.equal(next.members.some((member) => member.deviceId === aliceSecond.deviceId), true);
  assert.throws(() => bobNode.materializeWorkPackage(sent.packageId, join(dir, 'out')), /sender_no_longer_authorized/);
});

test('restart reconciliation completes a Work Package renamed before the database commit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-materialize-reconcile-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const policy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobPath = join(dir, 'bob.db');
  let bobNode = new AgentNode({ identity: bob, relay, storePath: bobPath, policy });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = join(dir, 'reconcile.txt'); writeFileSync(source, 'durable-result');
  const sent = await aliceNode.sendWorkPackage(commit.conversationId, { sourcePath: source, title: 'Crash reconciliation' });
  await bobNode.sync(16);
  bobNode.approveWorkPackage(sent.packageId);
  const pkg = bobNode.store.workPackage(sent.packageId);
  const manifest = JSON.parse(pkg.manifest_json);
  const outputRoot = join(dir, 'output');
  const destination = workPackageDestination(manifest, outputRoot);
  bobNode.store.beginWorkPackageMaterialization(sent.packageId, destination);
  assert.equal(writeWorkPackage(manifest, bobNode.store.workPackageChunks(sent.packageId), outputRoot), destination);
  bobNode.close();

  bobNode = new AgentNode({ identity: bob, relay, storePath: bobPath, policy });
  assert.deepEqual(bobNode.recoverWorkPackageMaterialization(sent.packageId), { state: 'completed', destination });
  assert.equal(readFileSync(join(destination, 'reconcile.txt'), 'utf8'), 'durable-result');
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'materialized');
  assert.equal(bobNode.store.workPackageChunks(sent.packageId).length, 0);
});

test('a pre-write crash is reconciled to blocked and can be explicitly retried', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-materialize-retry-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const policy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobPath = join(dir, 'bob.db');
  let bobNode = new AgentNode({ identity: bob, relay, storePath: bobPath, policy });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = join(dir, 'retry.txt'); writeFileSync(source, 'retry-result');
  const sent = await aliceNode.sendWorkPackage(commit.conversationId, { sourcePath: source, title: 'Retry after crash' });
  await bobNode.sync(16);
  bobNode.approveWorkPackage(sent.packageId);
  const manifest = bobNode.store.workPackageManifest(sent.packageId);
  const firstRoot = join(dir, 'first-output');
  bobNode.store.beginWorkPackageMaterialization(sent.packageId, workPackageDestination(manifest, firstRoot));
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(join(firstRoot, `.${sent.packageId}.${randomUUID()}.tmp`));
  bobNode.close();

  bobNode = new AgentNode({ identity: bob, relay, storePath: bobPath, policy });
  assert.deepEqual(bobNode.recoverWorkPackageMaterialization(sent.packageId), { state: 'blocked' });
  assert.equal(readdirSync(firstRoot).length, 0);
  const destination = bobNode.retryWorkPackageMaterialization(sent.packageId, join(dir, 'retry-output'));
  assert.equal(readFileSync(join(destination, 'retry.txt'), 'utf8'), 'retry-result');
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'materialized');
});

test('deny-by-default policy prevents a Work Package from entering staging', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-denied-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'bob.db'), policy: new LocalPolicy() });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = join(dir, 'denied.txt'); writeFileSync(source, 'do not stage');
  const sent = await aliceNode.sendWorkPackage(commit.conversationId, { sourcePath: source, title: 'Denied' });
  const received = await bobNode.sync();
  assert.equal(bobNode.store.task(sent.taskId).state, 'failed');
  assert.equal(bobNode.store.workPackage(sent.packageId), undefined);
  assert.equal(received.some((item) => item.rejected), true);
  assert.throws(() => bobNode.approveWorkPackage(sent.packageId), /not_found/);
});

test('current policy and task approval remain authoritative at materialization time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-policy-recheck-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const policy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'bob.db'), policy });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const sent = await aliceNode.sendWorkPackage(commit.conversationId, { title: 'Policy recheck' });
  await bobNode.sync();
  bobNode.approveWorkPackage(sent.packageId);
  policy.deny('work.package');
  assert.throws(() => bobNode.materializeWorkPackage(sent.packageId, join(dir, 'out')), /policy_changed/);
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'approved');
});

test('HTTP relay preserves expired-frame semantics so later outbox work is not blocked', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-http-expiry-'));
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const aliceToken = randomBytes(32).toString('base64url'); const bobToken = randomBytes(32).toString('base64url');
  const server = new HttpRelayServer({ path: join(dir, 'relay.db') });
  server.registerCredential(alice.devices[0].deviceId, aliceToken); server.registerCredential(bob.devices[0].deviceId, bobToken);
  const listening = await server.listen();
  const baseAlice = new HttpRelayTransport({ baseUrl: listening.url, deviceId: alice.devices[0].deviceId, token: aliceToken });
  let online = false;
  const gatedAlice = {
    publish(frame) { if (!online) throw new Error('relay_offline'); return baseAlice.publish(frame); },
    pull(mailbox, cursor, limit) { return baseAlice.pull(mailbox, cursor, limit); },
  };
  const bobTransport = new HttpRelayTransport({ baseUrl: listening.url, deviceId: bob.devices[0].deviceId, token: bobToken });
  const aliceNode = new AgentNode({ identity: alice, relay: gatedAlice, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({ identity: bob, relay: bobTransport, storePath: join(dir, 'bob.db') });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(async () => { aliceNode.close(); bobNode.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await aliceNode.send(commit.conversationId, { type: 'chat.message', payload: { text: 'expire' }, ttlMs: 1 })).state, 'queued');
  await delay(5);
  assert.equal((await aliceNode.send(commit.conversationId, { type: 'chat.message', payload: { text: 'survive' } })).state, 'queued');
  online = true;
  assert.equal(await aliceNode.flushOutbox(), 1);
  assert.equal((await bobNode.sync()).length, 1);
});

test('staged Work Packages expire to a terminal state and release their chunks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-expiry-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const policy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'bob.db'), policy });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const sent = await aliceNode.sendWorkPackage(commit.conversationId, { title: 'Short lived', ttlMs: 50 });
  await bobNode.sync();
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'ready');
  await delay(60);
  assert.equal(bobNode.store.expireWorkPackages(), 1);
  assert.equal(bobNode.store.workPackage(sent.packageId).status, 'expired');
  assert.equal(bobNode.store.task(sent.taskId).state, 'cancelled');
  assert.equal(bobNode.store.workPackageChunks(sent.packageId).length, 0);
});

test('aggregate staging quota rejects an unlimited stream of declared packages', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-quota-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const policy = new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db') });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'bob.db'), policy });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const makeDeclared = () => {
    const taskId = randomUUID();
    const unsigned = {
      schemaVersion: 1, packageId: randomUUID(), kind: 'request', taskId, title: 'Declared quota', instructions: '',
      createdAt: new Date().toISOString(), fileCount: 2, totalBytes: 64 * 1024 * 1024,
      files: [
        { path: 'a.bin', byteLength: 32 * 1024 * 1024, sha256: 'a'.repeat(64), mediaType: 'application/octet-stream', chunkCount: 342 },
        { path: 'b.bin', byteLength: 32 * 1024 * 1024, sha256: 'b'.repeat(64), mediaType: 'application/octet-stream', chunkCount: 342 },
      ],
    };
    return { ...unsigned, manifestHash: sha256(canonical(unsigned)) };
  };
  for (let index = 0; index < 5; index += 1) {
    const manifest = makeDeclared();
    await aliceNode.send(commit.conversationId, {
      type: 'task.proposal', payload: manifest,
      capabilityIntent: { taskId: manifest.taskId, capability: 'work.package', descriptor: { id: 'work.package', version: '1', risk: 'untrusted-content' } },
    });
  }
  const received = await bobNode.sync(10);
  assert.equal(received.filter((item) => item.rejected).length, 1);
  assert.equal(bobNode.store.db.prepare("SELECT COUNT(*) count FROM work_packages WHERE status='staging'").get().count, 4);
});

test('a result is rejected unless it references a locally sent Work Package task', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-result-binding-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice'); const bob = createIdentity('Bob');
  const policy = () => new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'alice.db'), policy: policy() });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'bob.db'), policy: policy() });
  const commit = installPair(aliceNode, bobNode, alice, bob);
  t.after(() => { aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true }); });
  const result = await bobNode.sendWorkResult(commit.conversationId, { taskId: randomUUID(), title: 'Unsolicited result' });
  const received = await aliceNode.sync();
  assert.equal(received[0].rejected, true);
  assert.equal(aliceNode.store.workPackage(result.packageId), undefined);
});
