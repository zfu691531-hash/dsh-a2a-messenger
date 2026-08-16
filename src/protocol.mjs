import { randomBytes, randomUUID } from 'node:crypto';
import { canonical, decryptAead, encryptAead, sha256, signObject, verifyObject } from './crypto.mjs';

export const PROTOCOL = 'dsh-a2a-messenger/0.1';
export const SCHEMA_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_INNER_BYTES = 262_144;
export const MAX_RECIPIENTS = 64;
export const MAX_ATTACHMENTS = 32;
export const MAX_ATTACHMENT_BYTES = 1_073_741_824;

const requiredFrameFields = [
  'protocol', 'schemaVersion', 'messageId', 'conversationId', 'senderAgentId',
  'senderDeviceId', 'senderKeyVersion', 'recipientDeviceIds', 'createdAt',
  'expiresAt', 'membershipEpoch', 'keyEpoch', 'senderSeq', 'traceId',
  'correlationId', 'algorithm', 'nonce', 'ciphertext', 'ciphertextHash', 'signature',
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const strictBase64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodedBase64(value, field, exactBytes) {
  if (typeof value !== 'string' || !strictBase64.test(value) || value.length % 4 !== 0) throw new Error(`invalid_${field}`);
  const decoded = Buffer.from(value, 'base64');
  if (exactBytes && decoded.length !== exactBytes) throw new Error(`invalid_${field}`);
  return decoded;
}

export function validateFrame(frame, { now = Date.now() } = {}) {
  if (!frame || typeof frame !== 'object') throw new Error('invalid_frame');
  if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) throw new Error('frame_too_large');
  for (const field of requiredFrameFields) if (!(field in frame)) throw new Error(`missing_${field}`);
  if (Object.keys(frame).some((field) => !requiredFrameFields.includes(field))) throw new Error('unknown_frame_field');
  if (frame.protocol !== PROTOCOL || frame.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported_protocol');
  for (const field of ['messageId', 'conversationId', 'senderAgentId', 'senderDeviceId', 'traceId', 'correlationId']) if (typeof frame[field] !== 'string' || !uuid.test(frame[field])) throw new Error(`invalid_${field}`);
  if (!Array.isArray(frame.recipientDeviceIds) || frame.recipientDeviceIds.length === 0 || frame.recipientDeviceIds.length > MAX_RECIPIENTS) throw new Error('invalid_recipients');
  if (new Set(frame.recipientDeviceIds).size !== frame.recipientDeviceIds.length || frame.recipientDeviceIds.some((id) => typeof id !== 'string' || !uuid.test(id))) throw new Error('invalid_recipients');
  for (const field of ['senderKeyVersion', 'membershipEpoch', 'keyEpoch', 'senderSeq']) if (!Number.isInteger(frame[field]) || frame[field] < 1) throw new Error(`invalid_${field}`);
  const createdAt = Date.parse(frame.createdAt);
  const expiresAt = Date.parse(frame.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt >= expiresAt || expiresAt - createdAt > 7 * 86_400_000) throw new Error('invalid_frame_time');
  if (new Date(createdAt).toISOString() !== frame.createdAt || new Date(expiresAt).toISOString() !== frame.expiresAt) throw new Error('invalid_frame_time');
  if (createdAt > now + 300_000) throw new Error('created_at_in_future');
  if (expiresAt <= now) throw new Error('expired');
  if (frame.algorithm !== 'AES-256-GCM+Ed25519') throw new Error('unsupported_algorithm');
  decodedBase64(frame.nonce, 'nonce', 12);
  const ciphertext = decodedBase64(frame.ciphertext, 'ciphertext');
  if (ciphertext.length > MAX_INNER_BYTES + 16) throw new Error('ciphertext_too_large');
  decodedBase64(frame.signature, 'signature', 64);
  if (typeof frame.ciphertextHash !== 'string' || !/^[a-f0-9]{64}$/.test(frame.ciphertextHash)) throw new Error('invalid_ciphertext_hash');
  return true;
}

function protectedHeader(frame) {
  const { ciphertext, ciphertextHash, signature, ...header } = frame;
  return header;
}

export function createEnvelope({
  conversation, sender, recipientDeviceIds, senderSeq, inner,
  ttlMs = 3_600_000, traceId = randomUUID(), correlationId = randomUUID(),
}) {
  if (!Array.isArray(recipientDeviceIds) || recipientDeviceIds.length === 0 || recipientDeviceIds.length > MAX_RECIPIENTS) throw new Error('invalid_recipients');
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 7 * 86_400_000) throw new Error('invalid_ttl');
  const innerBytes = Buffer.from(canonical(inner));
  if (innerBytes.length > MAX_INNER_BYTES) throw new Error('inner_too_large');
  const createdAt = new Date().toISOString();
  const header = {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    messageId: randomUUID(),
    conversationId: conversation.conversationId,
    senderAgentId: sender.agentId,
    senderDeviceId: sender.deviceId,
    senderKeyVersion: sender.keyVersion,
    recipientDeviceIds: [...new Set(recipientDeviceIds)].sort(),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    membershipEpoch: conversation.membershipEpoch,
    keyEpoch: conversation.keyEpoch,
    senderSeq,
    traceId,
    correlationId,
    algorithm: 'AES-256-GCM+Ed25519',
  };
  const nonce = randomBytes(12);
  const finalHeader = { ...header, nonce: nonce.toString('base64') };
  const sealed = encryptAead(innerBytes, conversation.epochKey, canonical(finalHeader), nonce);
  const frame = { ...finalHeader, ciphertext: sealed.ciphertext };
  frame.ciphertextHash = sha256(Buffer.from(frame.ciphertext, 'base64'));
  frame.signature = signObject({ protected: protectedHeader(frame), ciphertextHash: frame.ciphertextHash }, sender.signingPrivateKey);
  return frame;
}

export function openEnvelope(frame, { senderPublicKey, epochKey, recipientDeviceId, now = Date.now() }) {
  validateFrame(frame, { now });
  if (!frame.recipientDeviceIds.includes(recipientDeviceId)) throw new Error('not_a_recipient');
  const actualHash = sha256(Buffer.from(frame.ciphertext, 'base64'));
  if (actualHash !== frame.ciphertextHash) throw new Error('ciphertext_hash_mismatch');
  if (!verifyObject({ protected: protectedHeader(frame), ciphertextHash: frame.ciphertextHash }, frame.signature, senderPublicKey)) {
    throw new Error('invalid_signature');
  }
  const plaintext = decryptAead(frame.ciphertext, frame.nonce, epochKey, canonical(protectedHeader(frame)));
  if (plaintext.length > MAX_INNER_BYTES) throw new Error('inner_too_large');
  try { return JSON.parse(plaintext.toString('utf8')); }
  catch { throw new Error('invalid_inner_json'); }
}

export function validateAttachmentReferences(attachments) {
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw new Error('invalid_attachments');
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') throw new Error('invalid_attachment');
    const keys = Object.keys(attachment);
    if (keys.some((key) => !['attachmentId', 'url', 'sha256', 'byteLength', 'mediaType', 'encryption'].includes(key))) throw new Error('unknown_attachment_field');
    if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId.length < 1 || attachment.attachmentId.length > 128) throw new Error('invalid_attachment_id');
    if (typeof attachment.url !== 'string' || attachment.url.length > 2048 || !/^(https|ipfs):\/\//.test(attachment.url)) throw new Error('invalid_attachment_url');
    if (typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new Error('invalid_attachment_hash');
    if (!Number.isInteger(attachment.byteLength) || attachment.byteLength < 0 || attachment.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('invalid_attachment_length');
    if (typeof attachment.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.mediaType)) throw new Error('invalid_attachment_media_type');
    if (attachment.encryption !== undefined && (!attachment.encryption || typeof attachment.encryption !== 'object' || Array.isArray(attachment.encryption))) throw new Error('invalid_attachment_encryption');
  }
  return true;
}

export function makeInner({ type = 'chat.message', senderAgentId, recipientAgentIds, payload, replyTo, threadId, capabilityIntent, contextCapsule, attachments = [] }) {
  validateAttachmentReferences(attachments);
  const content = { type, senderAgentId, recipientAgentIds, payload, replyTo, threadId, capabilityIntent, contextCapsule, attachments };
  return { ...content, contentHash: sha256(canonical(content)) };
}
