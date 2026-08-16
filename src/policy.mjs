import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical, decryptAead, encryptAead, randomEpochKey, sha256, unwrapKeyForDevice, wrapKeyForDevice } from './crypto.mjs';

export class LocalPolicy {
  constructor({ allowCapabilities = [], requireHumanApproval = true } = {}) {
    this.allowed = new Set(allowCapabilities);
    this.requireHumanApproval = requireHumanApproval;
    this.version = 1;
  }

  decide(capability) {
    if (!this.allowed.has(capability)) return { allowed: false, requiresApproval: false, code: 'CAPABILITY_DENIED' };
    return { allowed: true, requiresApproval: this.requireHumanApproval };
  }

  allow(capability) { this.allowed.add(capability); this.version += 1; }
  deny(capability) { this.allowed.delete(capability); this.version += 1; }
}

export class LocalApprovalBroker {
  #secret = randomBytes(32);
  #used = new Set();

  issue(task, { approvedBy = 'local-user', ttlMs = 60_000 } = {}) {
    const payload = {
      taskId: task.task_id,
      bindingHash: task.binding_hash,
      policyVersion: task.policy_version,
      approvedBy,
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    return { ...payload, mac: createHmac('sha256', this.#secret).update(canonical(payload)).digest('base64') };
  }

  verifier() {
    return (token, task) => {
      if (!token || this.#used.has(token.nonce) || Date.parse(token.expiresAt) <= Date.now()) return false;
      if (token.taskId !== task.task_id || token.bindingHash !== task.binding_hash || token.policyVersion !== task.policy_version) return false;
      const { mac, ...payload } = token;
      const expected = createHmac('sha256', this.#secret).update(canonical(payload)).digest();
      const supplied = Buffer.from(mac ?? '', 'base64');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
      this.#used.add(token.nonce);
      return true;
    };
  }
}

export class TaskEngine {
  #verifyApproval;
  #authorizeExecution;
  constructor(store, policy = new LocalPolicy(), approvalVerifier = () => false, executionAuthorizer = () => true) {
    this.store = store;
    this.policy = policy;
    this.adapters = new Map();
    this.#verifyApproval = approvalVerifier;
    this.#authorizeExecution = executionAuthorizer;
  }

  register(capability, adapter) {
    const descriptor = adapter?.descriptor?.();
    if (!descriptor || descriptor.id !== capability || typeof descriptor.version !== 'string' || typeof descriptor.risk !== 'string') {
      throw new Error('invalid_adapter_descriptor');
    }
    this.adapters.set(capability, adapter);
  }

  classifyProposal(proposal) {
    const decision = this.policy.decide(proposal.capability);
    if (!decision.allowed) return { ...proposal, policyVersion: this.policy.version, state: 'failed', errorCode: decision.code };
    return { ...proposal, policyVersion: this.policy.version, state: decision.requiresApproval ? 'proposed' : 'accepted' };
  }

  approve(taskId, approvalToken) {
    const task = this.store.task(taskId);
    if (!task) throw new Error('task_not_found');
    const decision = this.policy.decide(task.capability);
    if (!decision.allowed || task.policy_version !== this.policy.version) throw new Error('policy_changed');
    if (decision.requiresApproval && !this.#verifyApproval(approvalToken, task)) throw new Error('human_approval_required');
    return this.store.approveTask(taskId, sha256(canonical(approvalToken ?? { automatic: true })));
  }

  async execute(taskId) {
    const task = this.store.task(taskId);
    if (!task || !['accepted', 'running'].includes(task.state)) throw new Error('task_not_accepted');
    const adapter = this.adapters.get(task.capability);
    if (!adapter) throw new Error('adapter_not_found');
    const localDescriptor = adapter.descriptor();
    if (sha256(canonical(localDescriptor)) !== task.descriptor_hash) throw new Error('capability_descriptor_mismatch');
    const idempotencyKey = sha256(canonical({ taskId, bindingHash: task.binding_hash, descriptorHash: task.descriptor_hash }));
    if (task.state === 'running') {
      const recovery = await adapter.recover?.(idempotencyKey) ?? { status: 'unknown' };
      if (recovery.status === 'completed') {
        this.store.completeExecution(taskId, recovery.result);
        return { duplicate: true, recovered: true, state: 'completed', result: recovery.result };
      }
      this.store.transitionTask(taskId, 'blocked', 'EXECUTION_RECOVERY_REQUIRED');
      return { duplicate: true, state: 'blocked' };
    }
    if (!this.#authorizeExecution(task)) throw new Error('sender_no_longer_authorized');
    const decision = this.policy.decide(task.capability);
    if (!decision.allowed || task.policy_version !== this.policy.version) throw new Error('policy_changed');
    if (!this.store.claimAndStart(taskId, idempotencyKey)) throw new Error('execution_claim_conflict');
    try {
      const result = await adapter.execute(JSON.parse(task.payload_json), idempotencyKey);
      this.store.completeExecution(taskId, result);
      return { duplicate: false, state: 'completed', result };
    } catch (error) {
      this.store.transitionTask(taskId, 'failed', 'ADAPTER_FAILED');
      throw error;
    }
  }
}

export function validateContextCapsule(capsule, { maxBytes = 16_384, maxTokens = 2_048, recipientAgentId, now = Date.now() } = {}) {
  const required = ['schemaVersion', 'capsuleId', 'provenance', 'source', 'scope', 'sensitivity', 'tokenBudget', 'byteBudget', 'createdAt', 'expiresAt', 'retractable', 'summary', 'references', 'allowedRecipients', 'contentHash', 'content'];
  for (const field of required) if (!(field in capsule)) throw new Error(`capsule_missing_${field}`);
  if (capsule.schemaVersion !== 1) throw new Error('capsule_schema_unsupported');
  if (!Number.isInteger(capsule.byteBudget) || capsule.byteBudget < 1 || !Number.isInteger(capsule.tokenBudget) || capsule.tokenBudget < 1) throw new Error('capsule_invalid_budget');
  if (capsule.byteBudget > maxBytes || capsule.tokenBudget > maxTokens) throw new Error('capsule_budget_exceeded');
  if (Buffer.byteLength(JSON.stringify(capsule)) > maxBytes) throw new Error('capsule_too_large');
  const createdAt = Date.parse(capsule.createdAt);
  const expiresAt = Date.parse(capsule.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt >= expiresAt) throw new Error('capsule_invalid_time');
  if (expiresAt <= now) throw new Error('capsule_expired');
  if (!Array.isArray(capsule.allowedRecipients) || capsule.allowedRecipients.length === 0) throw new Error('capsule_invalid_recipients');
  if (recipientAgentId && !capsule.allowedRecipients.includes(recipientAgentId)) throw new Error('capsule_recipient_denied');
  const contentBytes = Buffer.byteLength(canonical(capsule.content));
  const estimatedTokens = Math.ceil(canonical(capsule.content).length / 4);
  if (contentBytes > capsule.byteBudget || estimatedTokens > capsule.tokenBudget) throw new Error('capsule_declared_budget_exceeded');
  if (sha256(canonical(capsule.content)) !== capsule.contentHash) throw new Error('capsule_hash_mismatch');
  return true;
}

export function createContextCapsule({ source, scope, sensitivity = 'internal', summary, content, allowedRecipients, ttlMs = 3_600_000, tokenBudget = 512, byteBudget = 4096, references = [], retractable = true }) {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1, capsuleId: randomUUID(), provenance: 'user-authorized', source, scope,
    sensitivity, tokenBudget, byteBudget, createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    retractable, summary, references, allowedRecipients,
    contentHash: sha256(canonical(content)), content,
  };
}

export function sealContextCapsule(capsule, recipientDevices) {
  validateContextCapsule(capsule);
  const contentKey = randomEpochKey();
  const context = `capsule:${capsule.capsuleId}`;
  const sealed = encryptAead(Buffer.from(canonical(capsule)), contentKey, context);
  const wrappedKeys = {};
  for (const device of recipientDevices) wrappedKeys[device.deviceId] = wrapKeyForDevice(contentKey, device.encryptionPublicKey, context);
  return {
    schemaVersion: 1,
    capsuleId: capsule.capsuleId,
    allowedRecipients: capsule.allowedRecipients,
    algorithm: 'X25519+AES-256-GCM',
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    ciphertextHash: sha256(Buffer.from(sealed.ciphertext, 'base64')),
    wrappedKeys,
  };
}

export function openContextCapsule(sealed, localDevice) {
  if (sealed.schemaVersion !== 1 || sealed.algorithm !== 'X25519+AES-256-GCM') throw new Error('capsule_envelope_unsupported');
  const wrapped = sealed.wrappedKeys?.[localDevice.deviceId];
  if (!wrapped) throw new Error('capsule_recipient_denied');
  if (sha256(Buffer.from(sealed.ciphertext, 'base64')) !== sealed.ciphertextHash) throw new Error('capsule_ciphertext_hash_mismatch');
  const context = `capsule:${sealed.capsuleId}`;
  const contentKey = unwrapKeyForDevice(wrapped, localDevice.encryption.privateKey, context);
  const plaintext = decryptAead(sealed.ciphertext, sealed.nonce, contentKey, context);
  try { return JSON.parse(plaintext.toString('utf8')); }
  catch { throw new Error('capsule_invalid_json'); }
}
