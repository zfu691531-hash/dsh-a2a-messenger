import { deflateRawSync, inflateRawSync } from 'node:zlib';
const PREFIX = 'A2A1-';
export function encodeCode(payload) {
    const packed = deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    return PREFIX + packed.toString('base64url');
}
export function decodeCode(code) {
    const trimmed = code.trim();
    if (!trimmed.startsWith(PREFIX))
        return undefined;
    try {
        const packed = Buffer.from(trimmed.slice(PREFIX.length), 'base64url');
        const raw = JSON.parse(inflateRawSync(packed).toString('utf8'));
        if (raw.v !== 1)
            return undefined;
        if (raw.role !== 'offer' && raw.role !== 'answer')
            return undefined;
        if (typeof raw.name !== 'string' || typeof raw.sdp !== 'string' || raw.sdp.length === 0) {
            return undefined;
        }
        return raw;
    }
    catch {
        return undefined;
    }
}
