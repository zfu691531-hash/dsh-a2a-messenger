/**
 * Connect-code codec for direct sessions. A code carries one side's WebRTC
 * session description (with ICE candidates, non-trickle) plus a display name,
 * compressed and base64url-encoded so it survives chat apps intact.
 */
export interface DirectPayload {
    v: 1;
    role: 'offer' | 'answer';
    name: string;
    sdp: string;
}
export declare function encodeCode(payload: DirectPayload): string;
export declare function decodeCode(code: string): DirectPayload | undefined;
