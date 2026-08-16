import { randomUUID } from 'node:crypto';
import { canonical, randomEpochKey, sha256, signObject, unwrapKeyForDevice, verifyObject, wrapKeyForDevice } from './crypto.mjs';
import { identityFingerprint, publicDevice, verifyDeviceCertificate } from './identity.mjs';

function sortedMembers(members) {
  return [...members].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

function commitPayload(commit) {
  const { signature, commitHash, ...payload } = commit;
  return payload;
}

function validateMembers(members, priorRoots = {}) {
  const deviceIds = new Set();
  const roots = {};
  for (const member of members) {
    if (!verifyDeviceCertificate(member)) throw new Error('invalid_member_certificate');
    if (deviceIds.has(member.deviceId)) throw new Error('duplicate_device_id');
    deviceIds.add(member.deviceId);
    if (roots[member.agentId] && roots[member.agentId] !== member.rootPublicKey) throw new Error('agent_root_conflict');
    if (priorRoots[member.agentId] && priorRoots[member.agentId] !== member.rootPublicKey) throw new Error('agent_root_changed');
    roots[member.agentId] = member.rootPublicKey;
  }
  return roots;
}

export class ConversationController {
  constructor(controllerIdentity, participantDevices, { kind = 'group', conversationId = randomUUID() } = {}) {
    this.identity = controllerIdentity;
    this.device = controllerIdentity.devices[0];
    const controllerPublic = publicDevice(controllerIdentity, this.device);
    this.members = new Map();
    for (const participant of participantDevices) {
      if (!verifyDeviceCertificate(participant)) throw new Error('invalid_device_certificate');
      if (participant.agentId === controllerIdentity.agentId && participant.rootPublicKey !== controllerPublic.rootPublicKey) throw new Error('agent_root_conflict');
      const sameAgent = [...this.members.values()].find((member) => member.agentId === participant.agentId);
      if (sameAgent && sameAgent.rootPublicKey !== participant.rootPublicKey) throw new Error('agent_root_conflict');
      this.members.set(participant.deviceId, { ...participant, role: participant.agentId === controllerIdentity.agentId ? 'owner' : 'member' });
    }
    if (!this.members.has(controllerPublic.deviceId)) this.members.set(controllerPublic.deviceId, { ...controllerPublic, role: 'owner' });
    this.conversationId = conversationId;
    this.kind = kind;
    this.membershipEpoch = 0;
    this.keyEpoch = 0;
    this.previousCommitHash = null;
    this.epochKey = null;
  }

  commit(operation = { type: 'create', opId: randomUUID() }) {
    this.membershipEpoch += 1;
    this.keyEpoch += 1;
    this.epochKey = randomEpochKey();
    const context = `${this.conversationId}:${this.keyEpoch}`;
    const members = sortedMembers(this.members.values()).map(({ certificate, ...member }) => ({ ...member, certificate }));
    const wrappedEpochKeys = {};
    for (const member of members) wrappedEpochKeys[member.deviceId] = wrapKeyForDevice(this.epochKey, member.encryptionPublicKey, context);
    const payload = {
      protocol: 'dsh-a2a-messenger/0.1',
      schemaVersion: 1,
      type: 'membership.commit',
      conversationId: this.conversationId,
      kind: this.kind,
      controllerAgentId: this.identity.agentId,
      controllerDeviceId: this.device.deviceId,
      previousCommitHash: this.previousCommitHash,
      membershipEpoch: this.membershipEpoch,
      keyEpoch: this.keyEpoch,
      operation,
      members,
      wrappedEpochKeys,
      createdAt: new Date().toISOString(),
    };
    const commitHash = sha256(canonical(payload));
    const result = { ...payload, commitHash, signature: signObject({ ...payload, commitHash }, this.device.signing.privateKey) };
    this.previousCommitHash = commitHash;
    return result;
  }

  removeAgent(actorAgentId, targetAgentId) {
    if (actorAgentId !== this.identity.agentId) throw new Error('controller_required');
    if (targetAgentId === this.identity.agentId) throw new Error('cannot_remove_controller');
    const removed = [...this.members.values()].filter((member) => member.agentId === targetAgentId);
    if (removed.length === 0) throw new Error('member_not_found');
    for (const member of removed) this.members.delete(member.deviceId);
    return this.commit({ type: 'remove', opId: randomUUID(), actorAgentId, targetAgentId });
  }

  invite(actorAgentId, participant, role = 'member') {
    if (actorAgentId !== this.identity.agentId) throw new Error('owner_required');
    if (!['member', 'admin'].includes(role)) throw new Error('invalid_role');
    if (!verifyDeviceCertificate(participant)) throw new Error('invalid_device_certificate');
    const sameAgent = [...this.members.values()].find((member) => member.agentId === participant.agentId);
    if (sameAgent && sameAgent.rootPublicKey !== participant.rootPublicKey) throw new Error('agent_root_conflict');
    this.members.set(participant.deviceId, { ...participant, role });
    return this.commit({ type: 'invite.accepted', opId: randomUUID(), actorAgentId, targetAgentId: participant.agentId, targetDeviceId: participant.deviceId });
  }

  changeRole(actorAgentId, targetAgentId, role) {
    if (!['member', 'admin', 'owner'].includes(role) || actorAgentId !== this.identity.agentId) throw new Error('owner_required');
    for (const member of this.members.values()) if (member.agentId === targetAgentId) member.role = role;
    return this.commit({ type: 'role.change', opId: randomUUID(), actorAgentId, targetAgentId, role });
  }

  revokeMemberDevice(actorAgentId, revocation) {
    if (actorAgentId !== this.identity.agentId) throw new Error('controller_required');
    const target = this.members.get(revocation?.payload?.deviceId);
    if (!target || target.agentId !== revocation.payload.agentId) throw new Error('device_not_found');
    if (target.deviceId === this.device.deviceId) throw new Error('cannot_revoke_controller_device');
    if (!verifyObject(revocation.payload, revocation.signature, target.rootPublicKey)) throw new Error('invalid_revocation_signature');
    this.members.delete(target.deviceId);
    return this.commit({ ...revocation.payload, opId: randomUUID(), actorAgentId, proof: revocation.signature });
  }

  rotateMemberDevice(actorAgentId, participant) {
    if (actorAgentId !== this.identity.agentId) throw new Error('controller_required');
    const previous = this.members.get(participant.deviceId);
    if (!previous) throw new Error('device_not_found');
    if (!verifyDeviceCertificate(participant)) throw new Error('invalid_device_certificate');
    if (participant.agentId !== previous.agentId || participant.rootPublicKey !== previous.rootPublicKey) throw new Error('agent_root_changed');
    if (participant.keyVersion !== previous.keyVersion + 1) throw new Error('invalid_key_version');
    this.members.set(participant.deviceId, { ...participant, role: previous.role });
    if (participant.deviceId === this.device.deviceId) this.device = this.identity.devices.find((device) => device.deviceId === participant.deviceId);
    return this.commit({ type: 'device.rotate', opId: randomUUID(), actorAgentId, targetAgentId: participant.agentId, targetDeviceId: participant.deviceId });
  }
}

export function installMembershipCommit(previous, commit, localIdentity, localDevice = localIdentity.devices[0], options = {}) {
  if (commit.protocol !== 'dsh-a2a-messenger/0.1' || commit.schemaVersion !== 1) throw new Error('unsupported_commit');
  if (sha256(canonical(commitPayload(commit))) !== commit.commitHash) throw new Error('membership_hash_mismatch');
  const controller = commit.members.find((member) => member.deviceId === commit.controllerDeviceId && member.agentId === commit.controllerAgentId);
  if (!controller || !verifyDeviceCertificate(controller)) throw new Error('invalid_controller_certificate');
  const agentRoots = validateMembers(commit.members, previous?.agentRoots);
  if (!verifyObject({ ...commitPayload(commit), commitHash: commit.commitHash }, commit.signature, controller.signingPublicKey)) {
    throw new Error('invalid_membership_signature');
  }
  if (previous) {
    if (commit.conversationId !== previous.conversationId) throw new Error('conversation_id_changed');
    if (previous.controllerAgentId !== commit.controllerAgentId || previous.controllerDeviceId !== commit.controllerDeviceId) throw new Error('controller_changed');
    if (previous.controllerRootPublicKey !== controller.rootPublicKey) throw new Error('controller_key_changed');
    const signingChanged = previous.controllerSigningPublicKey !== controller.signingPublicKey;
    const validRotation = commit.operation?.type === 'device.rotate'
      && commit.operation.targetDeviceId === controller.deviceId
      && controller.keyVersion === previous.controllerKeyVersion + 1;
    if (signingChanged && !validRotation) throw new Error('controller_key_changed');
    if (!signingChanged && controller.keyVersion !== previous.controllerKeyVersion) throw new Error('controller_key_version_changed');
    if (commit.previousCommitHash !== previous.commitHash) throw new Error('membership_chain_gap');
    if (commit.membershipEpoch !== previous.membershipEpoch + 1 || commit.keyEpoch !== previous.keyEpoch + 1) throw new Error('stale_membership_epoch');
  } else {
    if (!options.expectedControllerAgentId || !options.expectedControllerFingerprint) throw new Error('unverified_controller');
    if (options.expectedControllerAgentId !== controller.agentId || options.expectedControllerFingerprint !== identityFingerprint(controller)) {
      throw new Error('controller_fingerprint_mismatch');
    }
    const isGenesis = commit.membershipEpoch === 1 && commit.keyEpoch === 1 && commit.previousCommitHash === null;
    const isAuthorizedInviteCheckpoint = commit.membershipEpoch > 1
      && commit.keyEpoch >= commit.membershipEpoch
      && typeof commit.previousCommitHash === 'string'
      && commit.operation?.type === 'invite.accepted'
      && commit.operation.targetAgentId === localIdentity.agentId
      && commit.operation.targetDeviceId === localDevice.deviceId
      && options.expectedConversationId === commit.conversationId
      && options.expectedInviteOperationId === commit.operation.opId
      && options.expectedInviteDeviceId === localDevice.deviceId;
    if (!isGenesis && !isAuthorizedInviteCheckpoint) throw new Error('invalid_membership_checkpoint');
  }
  const localMember = commit.members.find((member) => member.agentId === localIdentity.agentId && member.deviceId === localDevice.deviceId);
  if (!localMember) throw new Error('local_device_not_member');
  if (localMember.rootPublicKey !== localIdentity.root.publicKey || !verifyDeviceCertificate(localMember)) throw new Error('local_identity_mismatch');
  const wrapped = commit.wrappedEpochKeys[localDevice.deviceId];
  if (!wrapped) throw new Error('missing_wrapped_epoch_key');
  const context = `${commit.conversationId}:${commit.keyEpoch}`;
  const epochKey = unwrapKeyForDevice(wrapped, localDevice.encryption.privateKey, context);
  return {
    conversationId: commit.conversationId,
    kind: commit.kind,
    controllerAgentId: commit.controllerAgentId,
    controllerDeviceId: commit.controllerDeviceId,
    controllerRootPublicKey: controller.rootPublicKey,
    controllerSigningPublicKey: controller.signingPublicKey,
    controllerKeyVersion: controller.keyVersion,
    membershipEpoch: commit.membershipEpoch,
    keyEpoch: commit.keyEpoch,
    commitHash: commit.commitHash,
    members: commit.members,
    agentRoots,
    epochKey,
    verified: true,
  };
}
