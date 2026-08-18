import type { DirectIdentity } from './identity.js';
/**
 * Connect-code codec for direct sessions. A code carries one side's WebRTC
 * session description (with ICE candidates, non-trickle) plus a display name,
 * compressed and base64url-encoded so it survives chat apps intact.
 */
export interface DirectPayload {
    v: 2;
    role: 'offer' | 'answer';
    name: string;
    sdp: string;
    sessionId: string;
    publicKey: string;
    signature: string;
}
export type UnsignedDirectPayload = Omit<DirectPayload, 'signature'>;
export declare function encodeCode(payload: UnsignedDirectPayload, identity: DirectIdentity): string;
export declare function decodeCode(code: string): DirectPayload | undefined;
export declare function verifyPayload(payload: DirectPayload): string | undefined;
export declare function isLegacyCode(code: string): boolean;
