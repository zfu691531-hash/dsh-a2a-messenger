import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentNode } from './agent.mjs';
import { ConversationController, installMembershipCommit } from './conversation.mjs';
import { HttpRelayServer, HttpRelayTransport } from './http-relay.mjs';
import { createIdentity, identityFingerprint, publicDevice } from './identity.mjs';
import { LocalPolicy } from './policy.mjs';

export async function runWorkDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a2a-work-demo-'));
  const alice = createIdentity('Alice Agent');
  const bob = createIdentity('Bob Agent');
  const aliceToken = randomBytes(32).toString('base64url');
  const bobToken = randomBytes(32).toString('base64url');
  const server = new HttpRelayServer({ path: join(dir, 'relay.db') });
  let aliceNode;
  let bobNode;
  try {
    server.registerCredential(alice.devices[0].deviceId, aliceToken);
    server.registerCredential(bob.devices[0].deviceId, bobToken);
    const relay = await server.listen();
    const policy = () => new LocalPolicy({ allowCapabilities: ['work.package'], requireHumanApproval: false });
    aliceNode = new AgentNode({
      identity: alice, storePath: join(dir, 'alice.db'), policy: policy(),
      relay: new HttpRelayTransport({ baseUrl: relay.url, deviceId: alice.devices[0].deviceId, token: aliceToken }),
    });
    bobNode = new AgentNode({
      identity: bob, storePath: join(dir, 'bob.db'), policy: policy(),
      relay: new HttpRelayTransport({ baseUrl: relay.url, deviceId: bob.devices[0].deviceId, token: bobToken }),
    });
    const controller = new ConversationController(alice, [publicDevice(alice), publicDevice(bob)], { kind: 'direct' });
    const commit = controller.commit();
    const trust = { expectedControllerAgentId: alice.agentId, expectedControllerFingerprint: identityFingerprint(alice) };
    aliceNode.installConversation(installMembershipCommit(null, commit, alice, alice.devices[0], trust));
    bobNode.installConversation(installMembershipCommit(null, commit, bob, bob.devices[0], trust));

    const source = join(dir, 'source'); mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'src', 'hello.mjs'), 'export const hello = "direct work package";\n');
    writeFileSync(join(source, 'README.md'), '# no forge required\n');
    const request = await aliceNode.sendWorkPackage(commit.conversationId, {
      sourcePath: source, title: 'Review this code', instructions: 'Check the source and return a review note.',
    });
    await bobNode.sync();
    bobNode.approveWorkPackage(request.packageId);
    const received = bobNode.materializeWorkPackage(request.packageId, join(dir, 'bob-received'));

    const resultSource = join(dir, 'result'); mkdirSync(resultSource);
    writeFileSync(join(resultSource, 'review.txt'), 'Reviewed: source received and verified.\n');
    const result = await bobNode.sendWorkResult(commit.conversationId, {
      taskId: request.taskId, sourcePath: resultSource, title: 'Review result', instructions: 'Review completed.',
    });
    await aliceNode.sync();
    aliceNode.approveWorkPackage(result.packageId);
    const returned = aliceNode.materializeWorkPackage(result.packageId, join(dir, 'alice-results'));

    return {
      ok: true,
      transport: 'http-sqlite-loopback',
      request: { state: request.state, fileCount: request.fileCount, messageCount: request.messageCount },
      receiver: {
        materialized: readFileSync(join(received, 'src', 'hello.mjs'), 'utf8').includes('direct work package'),
        taskState: bobNode.store.task(request.taskId).state,
      },
      result: {
        state: result.state,
        returned: readFileSync(join(returned, 'review.txt'), 'utf8').startsWith('Reviewed:'),
      },
      relayContainsPlaintext: server.relay.rawFrames().some((frame) => frame.includes('direct work package') || frame.includes('Reviewed:')),
      limits: { sameMachineOnly: true, publicInternetVerified: false, physicalMultiDeviceVerified: false },
    };
  } finally {
    try { aliceNode?.close(); } catch {}
    try { bobNode?.close(); } catch {}
    try { await server.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}
