import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fingerprintPublicKey, signText, verifyText } from './identity.js';
const PREFIX = 'A2A2-';
const LEGACY_PREFIX = 'A2A1-';
const MAX_CODE_CHARS = 256_000;
const MAX_UNPACKED_BYTES = 192 * 1024;
const MAX_SDP_BYTES = 128 * 1024;
export function encodeCode(payload, identity) {
    if (payload.publicKey !== identity.publicKey) {
        throw new Error('signaling public key does not match the local identity');
    }
    const signed = {
        ...payload,
        signature: signText(identity, canonicalPayload(payload)),
    };
    const packed = deflateRawSync(Buffer.from(JSON.stringify(signed), 'utf8'));
    return PREFIX + packed.toString('base64url');
}
export function decodeCode(code) {
    const trimmed = code.trim();
    if (!trimmed.startsWith(PREFIX) || trimmed.length > MAX_CODE_CHARS)
        return undefined;
    try {
        const packed = Buffer.from(trimmed.slice(PREFIX.length), 'base64url');
        const unpacked = inflateRawSync(packed, { maxOutputLength: MAX_UNPACKED_BYTES });
        const raw = JSON.parse(unpacked.toString('utf8'));
        if (raw.v !== 2)
            return undefined;
        if (raw.role !== 'offer' && raw.role !== 'answer')
            return undefined;
        if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 128 ||
            typeof raw.sdp !== 'string' || raw.sdp.length === 0 ||
            Buffer.byteLength(raw.sdp, 'utf8') > MAX_SDP_BYTES ||
            typeof raw.sessionId !== 'string' || raw.sessionId.length === 0 || raw.sessionId.length > 128 ||
            typeof raw.publicKey !== 'string' || raw.publicKey.length === 0 || raw.publicKey.length > 256 ||
            typeof raw.signature !== 'string' || raw.signature.length === 0 || raw.signature.length > 256) {
            return undefined;
        }
        return raw;
    }
    catch {
        return undefined;
    }
}
export function verifyPayload(payload) {
    const { signature, ...unsigned } = payload;
    if (!verifyText(payload.publicKey, canonicalPayload(unsigned), signature))
        return undefined;
    try {
        return fingerprintPublicKey(payload.publicKey);
    }
    catch {
        return undefined;
    }
}
export function isLegacyCode(code) {
    return code.trim().startsWith(LEGACY_PREFIX);
}
function canonicalPayload(payload) {
    return JSON.stringify([
        payload.v,
        payload.role,
        payload.name,
        payload.sdp,
        payload.sessionId,
        payload.publicKey,
    ]);
}
