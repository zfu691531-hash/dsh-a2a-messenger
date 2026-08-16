import { LocalStore } from './store.mjs';
import { LocalPolicy, TaskEngine, openContextCapsule, sealContextCapsule, validateContextCapsule } from './policy.mjs';
import { createEnvelope, makeInner, openEnvelope, validateAttachmentReferences } from './protocol.mjs';
import { publicDevice } from './identity.mjs';
import { canonical, sha256 } from './crypto.mjs';

const SAFE_ERROR_CODES = new Set([
  'UNKNOWN_CONVERSATION', 'FUTURE_EPOCH', 'STALE_EPOCH', 'SENDER_NOT_MEMBER',
  'SENDER_KEY_VERSION_MISMATCH', 'INNER_SENDER_MISMATCH', 'CONTENT_HASH_MISMATCH',
  'INVALID_CAPABILITY_INTENT', 'INVALID_INNER_JSON', 'INVALID_SIGNATURE',
  'CIPHERTEXT_HASH_MISMATCH', 'NOT_A_RECIPIENT', 'EXPIRED', 'CREATED_AT_IN_FUTURE',
  'INVALID_FRAME', 'FRAME_TOO_LARGE', 'CIPHERTEXT_TOO_LARGE', 'INNER_TOO_LARGE',
  'UNSUPPORTED_PROTOCOL', 'UNSUPPORTED_ALGORITHM', 'CAPSULE_RECIPIENT_DENIED',
  'CAPSULE_INVALID_JSON', 'CAPSULE_HASH_MISMATCH', 'CAPSULE_EXPIRED',
  'CAPSULE_CIPHERTEXT_HASH_MISMATCH', 'CAPSULE_ENVELOPE_UNSUPPORTED',
  'TASK_ID_COLLISION', 'INVALID_MESSAGE',
]);

function deliveryError(code, retryable = false) {
  const error = new Error(code.toLowerCase());
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function auditErrorCode(error) {
  const candidate = error?.code ?? String(error?.message ?? '').toUpperCase();
  return SAFE_ERROR_CODES.has(candidate) ? candidate : 'INVALID_MESSAGE';
}

export class AgentNode {
  constructor({ identity, storePath = ':memory:', relay, policy = new LocalPolicy(), approvalVerifier, device = identity.devices[0] }) {
    this.identity = identity;
    this.device = device;
    this.publicDevice = publicDevice(identity, device);
    this.store = new LocalStore(storePath);
    this.relay = relay;
    this.conversations = new Map(this.store.loadConversations().map((view) => [view.conversationId, view]));
    this.tasks = new TaskEngine(this.store, policy, approvalVerifier, (task) => {
      const conversation = this.conversations.get(task.conversation_id);
      return Boolean(conversation?.members.some((member) => member.agentId === task.sender_agent_id));
    });
  }

  close() { this.store.close(); }
  installConversation(view) {
    if (!view?.verified) throw new Error('unverified_conversation');
    const current = this.conversations.get(view.conversationId);
    if (current) {
      if (view.membershipEpoch < current.membershipEpoch || view.keyEpoch < current.keyEpoch) throw new Error('conversation_rollback');
      if (view.membershipEpoch === current.membershipEpoch && view.commitHash !== current.commitHash) throw new Error('conversation_fork');
      if (view.controllerRootPublicKey !== current.controllerRootPublicKey) throw new Error('controller_key_changed');
    }
    this.store.saveConversation(view);
    this.conversations.set(view.conversationId, view);
  }

  async send(conversationId, input) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error('conversation_not_found');
    const selfMember = conversation.members.find((member) => member.deviceId === this.device.deviceId);
    if (!selfMember) throw new Error('sender_not_member');
    let recipients = conversation.members.filter((member) => member.deviceId !== this.device.deviceId);
    let contextCapsule = input.contextCapsule;
    if (contextCapsule) {
      validateContextCapsule(contextCapsule);
      const allowed = new Set(contextCapsule.allowedRecipients);
      const knownAgents = new Set(conversation.members.map((member) => member.agentId));
      for (const agentId of allowed) if (!knownAgents.has(agentId)) throw new Error('capsule_recipient_not_member');
      recipients = recipients.filter((member) => allowed.has(member.agentId));
      if (recipients.length === 0) throw new Error('capsule_no_remote_recipient');
      contextCapsule = sealContextCapsule(contextCapsule, recipients);
    }
    const senderSeq = this.store.nextSequence(`${conversationId}:${conversation.keyEpoch}:${this.device.deviceId}`);
    const inner = makeInner({
      type: input.type,
      senderAgentId: this.identity.agentId,
      recipientAgentIds: [...new Set(recipients.map((member) => member.agentId))],
      payload: input.payload,
      replyTo: input.replyTo,
      threadId: input.threadId,
      capabilityIntent: input.capabilityIntent,
      contextCapsule,
      attachments: input.attachments,
    });
    const frame = createEnvelope({
      conversation,
      sender: { ...this.publicDevice, signingPrivateKey: this.device.signing.privateKey },
      recipientDeviceIds: recipients.map((member) => member.deviceId),
      senderSeq,
      inner,
      ttlMs: input.ttlMs,
    });
    this.store.putOutbox(frame);
    try {
      this.relay.publish(frame);
      this.store.markPublished(frame.messageId);
      return { state: 'published', frame };
    } catch (error) {
      if (error.message !== 'relay_offline') throw error;
      return { state: 'queued', frame };
    }
  }

  flushOutbox() {
    let published = 0;
    for (const frame of this.store.pendingOutbox()) {
      try {
        this.relay.publish(frame);
        this.store.markPublished(frame.messageId);
        published += 1;
      } catch (error) {
        if (error.message !== 'expired') throw error;
        this.store.markOutboxExpired(frame.messageId);
      }
    }
    return published;
  }

  receiveFrame(frame) {
    const conversation = this.conversations.get(frame.conversationId);
    if (!conversation) throw deliveryError('UNKNOWN_CONVERSATION');
    if (frame.membershipEpoch < conversation.membershipEpoch || frame.keyEpoch < conversation.keyEpoch) throw deliveryError('STALE_EPOCH');
    if (frame.membershipEpoch > conversation.membershipEpoch || frame.keyEpoch > conversation.keyEpoch) throw deliveryError('FUTURE_EPOCH', true);
    const sender = conversation.members.find((member) => member.deviceId === frame.senderDeviceId && member.agentId === frame.senderAgentId);
    if (!sender) throw deliveryError('SENDER_NOT_MEMBER');
    if (sender.keyVersion !== frame.senderKeyVersion) throw deliveryError('SENDER_KEY_VERSION_MISMATCH');
    const inner = openEnvelope(frame, {
      senderPublicKey: sender.signingPublicKey,
      epochKey: conversation.epochKey,
      recipientDeviceId: this.device.deviceId,
    });
    if (inner.senderAgentId !== frame.senderAgentId) throw deliveryError('INNER_SENDER_MISMATCH');
    const { contentHash, ...content } = inner;
    if (sha256(canonical(content)) !== contentHash) throw deliveryError('CONTENT_HASH_MISMATCH');
    validateAttachmentReferences(inner.attachments);
    const classification = {};
    if (inner.contextCapsule) {
      const capsule = openContextCapsule(inner.contextCapsule, this.device);
      validateContextCapsule(capsule, { recipientAgentId: this.identity.agentId });
      classification.inboxStatus = 'quarantined';
      classification.capsule = capsule;
    }
    if (inner.type === 'task.proposal') {
      const intent = inner.capabilityIntent;
      if (!intent?.taskId || !intent?.capability || !intent?.descriptor
        || intent.descriptor.id !== intent.capability
        || typeof intent.descriptor.version !== 'string' || typeof intent.descriptor.risk !== 'string') {
        throw deliveryError('INVALID_CAPABILITY_INTENT');
      }
      const descriptorHash = sha256(canonical(intent.descriptor));
      const payloadHash = sha256(canonical(inner.payload ?? {}));
      const bindingHash = sha256(canonical({
        senderAgentId: frame.senderAgentId,
        conversationId: frame.conversationId,
        messageId: frame.messageId,
        taskId: intent.taskId,
        capability: intent.capability,
        descriptorHash,
        payloadHash,
      }));
      classification.task = this.tasks.classifyProposal({
        taskId: intent.taskId,
        capability: intent.capability,
        descriptor: intent.descriptor,
        descriptorHash,
        bindingHash,
        senderAgentId: frame.senderAgentId,
        conversationId: frame.conversationId,
        messageId: frame.messageId,
        payloadHash,
        payload: inner.payload,
      });
    }
    return this.store.receive(frame, inner, classification);
  }

  sync(limit = 100) {
    const mailbox = this.device.deviceId;
    let cursor = this.store.getCursor(mailbox);
    const results = [];
    for (const delivery of this.relay.pull(mailbox, cursor, limit)) {
      try {
        results.push({ deliveryId: delivery.deliveryId, ...this.receiveFrame(delivery.frame) });
      } catch (error) {
        const errorCode = auditErrorCode(error);
        this.store.audit('delivery.rejected', {
          messageId: delivery.frame.messageId,
          traceId: delivery.frame.traceId,
          outcome: 'rejected',
          errorCode,
        });
        results.push({ deliveryId: delivery.deliveryId, rejected: true, retryable: error.retryable === true, error: errorCode });
        if (error.retryable === true) break;
      }
      cursor = delivery.deliveryId;
      this.store.setCursor(mailbox, cursor);
    }
    return results;
  }
}
