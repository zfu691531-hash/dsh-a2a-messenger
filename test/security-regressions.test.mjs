import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AgentNode, auditErrorCode } from '../src/agent.mjs';
import { addDevice, createIdentity, identityFingerprint, publicDevice, revokeDevice, rotateDevice } from '../src/identity.mjs';
import { ConversationController, installMembershipCommit } from '../src/conversation.mjs';
import { openEnvelope, validateAttachmentReferences, validateFrame } from '../src/protocol.mjs';
import { createContextCapsule, validateContextCapsule } from '../src/policy.mjs';
import { LoopbackRelayTransport } from '../src/relay.mjs';
import { signObject } from '../src/crypto.mjs';

function recertify(identity, device) {
  device.certificate = signObject({
    schemaVersion: 1, agentId: identity.agentId, deviceId: device.deviceId,
    keyVersion: device.keyVersion, signingPublicKey: device.signing.publicKey,
    encryptionPublicKey: device.encryption.publicKey, issuedAt: device.issuedAt,
  }, identity.root.privateKey);
}

test('same-ID replacement controller key cannot extend a membership chain', () => {
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob)]);
  const genesis = controller.commit();
  const bobView = installMembershipCommit(null, genesis, bob, bob.devices[0], {
    expectedControllerAgentId: alice.agentId,
    expectedControllerFingerprint: identityFingerprint(alice),
  });

  const attacker = createIdentity('Attacker');
  attacker.agentId = alice.agentId;
  attacker.devices = [];
  const attackerDevice = addDevice(attacker, 'forged');
  attackerDevice.deviceId = alice.devices[0].deviceId;
  recertify(attacker, attackerDevice);
  const forgedController = new ConversationController(attacker, [publicDevice(attacker), publicDevice(bob)], { conversationId: genesis.conversationId });
  forgedController.membershipEpoch = 1;
  forgedController.keyEpoch = 1;
  forgedController.previousCommitHash = genesis.commitHash;
  const forged = forgedController.commit({ type: 'role.change', opId: 'forged' });
  assert.throws(() => installMembershipCommit(bobView, forged, bob), /agent_root_changed|controller_key_changed/);
});

test('root-signed device revocation removes future epoch key access', () => {
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const bobSecond = addDevice(bob, 'second');
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob), publicDevice(bob, bobSecond)]);
  const genesis = controller.commit();
  const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
  const aliceView = installMembershipCommit(null, genesis, alice, alice.devices[0], trust);
  const oldBobView = installMembershipCommit(null, genesis, bob, bobSecond, trust);
  const revocation = revokeDevice(bob, bobSecond.deviceId);
  const next = controller.revokeMemberDevice(alice.agentId, revocation);
  const updated = installMembershipCommit(aliceView, next, alice);
  assert.equal(updated.keyEpoch, 2);
  assert.equal(next.members.some((member) => member.deviceId === bobSecond.deviceId), false);
  assert.equal(next.wrappedEpochKeys[bobSecond.deviceId], undefined);
  assert.throws(() => installMembershipCommit(oldBobView, next, bob, bobSecond), /local_device_not_member/);
});

test('controller device rotation advances the pinned signing key chain', () => {
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob)]);
  const genesis = controller.commit();
  const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
  const aliceView = installMembershipCommit(null, genesis, alice, alice.devices[0], trust);
  const bobView = installMembershipCommit(null, genesis, bob, bob.devices[0], trust);
  const oldSigningKey = aliceView.controllerSigningPublicKey;
  rotateDevice(alice, alice.devices[0].deviceId);
  const rotation = controller.rotateMemberDevice(alice.agentId, publicDevice(alice));
  const nextAlice = installMembershipCommit(aliceView, rotation, alice);
  const nextBob = installMembershipCommit(bobView, rotation, bob);
  assert.notEqual(nextAlice.controllerSigningPublicKey, oldSigningKey);
  assert.equal(nextAlice.controllerKeyVersion, 2);
  assert.equal(nextAlice.commitHash, nextBob.commitHash);
});

test('a membership commit cannot extend a different conversation', () => {
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob)]);
  const genesis = controller.commit();
  const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
  const view = installMembershipCommit(null, genesis, bob, bob.devices[0], trust);
  const next = controller.changeRole(alice.agentId, bob.agentId, 'admin');
  assert.throws(() => installMembershipCommit({ ...view, conversationId: '00000000-0000-4000-8000-000000000000' }, next, bob), /conversation_id_changed/);
});

test('conversation membership and latest epoch survive endpoint restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a2a-state-'));
  const db = join(dir, 'bob.db');
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob)]);
  const genesis = controller.commit();
  const view = installMembershipCommit(null, genesis, bob, bob.devices[0], {
    expectedControllerAgentId: alice.agentId,
    expectedControllerFingerprint: identityFingerprint(alice),
  });
  const first = new AgentNode({ identity: bob, storePath: db, relay });
  first.installConversation(view);
  first.close();
  const restarted = new AgentNode({ identity: bob, storePath: db, relay });
  assert.equal(restarted.conversations.get(genesis.conversationId).commitHash, genesis.commitHash);
  restarted.close(); relay.close(); rmSync(dir, { recursive: true, force: true });
});

test('future-epoch message is retried after membership catches up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a2a-future-'));
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob)]);
  const genesis = controller.commit();
  const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
  const aliceNode = new AgentNode({ identity: alice, relay, storePath: join(dir, 'a.db') });
  const bobNode = new AgentNode({ identity: bob, relay, storePath: join(dir, 'b.db') });
  aliceNode.installConversation(installMembershipCommit(null, genesis, alice, alice.devices[0], trust));
  bobNode.installConversation(installMembershipCommit(null, genesis, bob, bob.devices[0], trust));
  const next = controller.changeRole(alice.agentId, bob.agentId, 'admin');
  aliceNode.installConversation(installMembershipCommit(aliceNode.conversations.get(genesis.conversationId), next, alice));
  await aliceNode.send(genesis.conversationId, { type: 'chat.message', payload: { text: 'next epoch' } });
  assert.equal((await bobNode.sync())[0].retryable, true);
  bobNode.installConversation(installMembershipCommit(bobNode.conversations.get(genesis.conversationId), next, bob));
  assert.equal((await bobNode.sync())[0].duplicate, false);
  aliceNode.close(); bobNode.close(); relay.close(); rmSync(dir, { recursive: true, force: true });
});

test('restricted Capsule plaintext is unavailable to an excluded group member', async () => {
  const relay = new LoopbackRelayTransport(':memory:');
  const alice = createIdentity('Alice');
  const bob = createIdentity('Bob');
  const carol = createIdentity('Carol');
  const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob), publicDevice(carol)]);
  const genesis = controller.commit();
  const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
  const aliceNode = new AgentNode({ identity: alice, relay });
  aliceNode.installConversation(installMembershipCommit(null, genesis, alice, alice.devices[0], trust));
  const capsule = createContextCapsule({ source: 'user', scope: 'bob-only', summary: 'private', content: 'BOB-ONLY-SECRET', allowedRecipients: [bob.agentId] });
  const sent = await aliceNode.send(genesis.conversationId, { type: 'context.capsule', payload: {}, contextCapsule: capsule });
  const carolView = installMembershipCommit(null, genesis, carol, carol.devices[0], trust);
  assert.equal(sent.frame.recipientDeviceIds.includes(carol.devices[0].deviceId), false);
  const groupPlaintext = openEnvelope(sent.frame, { senderPublicKey: publicDevice(alice).signingPublicKey, epochKey: carolView.epochKey, recipientDeviceId: bob.devices[0].deviceId });
  assert.equal(JSON.stringify(groupPlaintext).includes('BOB-ONLY-SECRET'), false);
  aliceNode.close(); relay.close();
});

test('Capsule metadata and frame size are strictly validated', () => {
  const bob = createIdentity('Bob');
  const capsule = createContextCapsule({ source: 'user', scope: 'test', summary: 'bad hash', content: 'content', allowedRecipients: [bob.agentId] });
  capsule.contentHash = '0'.repeat(64);
  assert.throws(() => validateContextCapsule(capsule, { recipientAgentId: bob.agentId }), /capsule_hash_mismatch/);
  assert.throws(() => validateFrame({ protocol: 'dsh-a2a-messenger/0.1', schemaVersion: 1, recipientDeviceIds: ['x'], senderSeq: 1, expiresAt: new Date(Date.now() + 1000).toISOString(), ciphertext: 'A'.repeat(2_000_000) }), /frame_too_large|missing_/);
});

test('release controls exclude live relay credential files', () => {
  const root = join(import.meta.dirname, '..');
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^relay-credentials\.json$/m);
  assert.match(readFileSync(join(root, 'scripts', 'release-check.mjs'), 'utf8'), /sensitive-file:relay-credentials\.json/);
  assert.equal(JSON.parse(readFileSync(join(root, 'examples', 'relay-credentials.example.json'), 'utf8')).devices[0].token, 'REPLACE_ME');
});

test('audit errors are fixed metadata codes and attachment references are bounded', () => {
  assert.equal(auditErrorCode(new SyntaxError('SECRET-PLAINTEXT-FRAGMENT')), 'INVALID_MESSAGE');
  assert.equal(auditErrorCode(Object.assign(new Error('ignored'), { code: 'INVALID_SIGNATURE' })), 'INVALID_SIGNATURE');
  assert.equal(validateAttachmentReferences([{
    attachmentId: 'artifact-1',
    url: 'https://example.invalid/artifact',
    sha256: 'a'.repeat(64),
    byteLength: 128,
    mediaType: 'application/octet-stream',
  }]), true);
  assert.throws(() => validateAttachmentReferences([{
    attachmentId: 'artifact-1', url: 'file:///etc/passwd', sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'text/plain',
  }]), /invalid_attachment_url/);
});
