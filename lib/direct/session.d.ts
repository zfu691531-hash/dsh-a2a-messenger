import type { IncomingMessage } from '../types.js';
import type { DirectIdentity } from './identity.js';
/**
 * Direct (peer-to-peer) session over a WebRTC data channel. Signaling is a
 * human-carried connect code: A generates an offer code, B pastes it and
 * returns an answer code, A pastes that back — then all traffic flows
 * directly between the two machines with no third party. Both sides must be
 * online at the same time; the session dies when either side closes it.
 *
 * The WebRTC engine (`@roamhq/wrtc`) is an optional native dependency loaded
 * lazily, so the mailbox transport keeps working even where it cannot install.
 */
export type DirectState = 'idle' | 'waiting-answer' | 'connecting' | 'connected' | 'closed' | 'failed';
interface RtcDataChannelLike {
    readyState: string;
    send(data: string): void;
    close(): void;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onmessage: ((evt: {
        data: unknown;
    }) => void) | null;
}
interface RtcPeerConnectionLike {
    localDescription: {
        sdp: string;
    } | null;
    iceGatheringState: string;
    connectionState: string;
    createDataChannel(label: string): RtcDataChannelLike;
    createOffer(): Promise<{
        type: string;
        sdp: string;
    }>;
    createAnswer(): Promise<{
        type: string;
        sdp: string;
    }>;
    setLocalDescription(desc: {
        type: string;
        sdp: string;
    }): Promise<void>;
    setRemoteDescription(desc: {
        type: string;
        sdp: string;
    }): Promise<void>;
    close(): void;
    onicegatheringstatechange: (() => void) | null;
    ondatachannel: ((evt: {
        channel: RtcDataChannelLike;
    }) => void) | null;
    onconnectionstatechange: (() => void) | null;
}
interface RtcModuleLike {
    RTCPeerConnection: new (config: unknown) => RtcPeerConnectionLike;
}
export interface DirectSessionOptions {
    selfName: string;
    identity: DirectIdentity;
    /** Trusted fingerprint -> expected display name. Empty means deny every peer. */
    trustedPeers: ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>);
    onMessage: (msg: IncomingMessage) => 'added' | 'duplicate' | 'rejected-too-large' | 'rejected-inbox-full' | 'self' | void;
    onStateChange?: (state: DirectState) => void;
    /** Injectable WebRTC module (tests); defaults to lazy `@roamhq/wrtc`. */
    rtcModule?: RtcModuleLike;
    stunServers?: string[];
    icePolicy?: IcePolicy;
    turnServers?: string[];
    turnUsername?: string;
    turnCredential?: string;
    /** Max time to wait for ICE gathering before using what we have. */
    gatherTimeoutMs?: number;
}
export type IcePolicy = 'strict' | 'stun' | 'relay';
export type DirectReceiptStatus = 'sent' | 'quarantined' | 'accepted' | 'rejected' | 'expired';
export interface DirectReceipt {
    id: string;
    status: DirectReceiptStatus;
    updatedAt: number;
}
export interface DirectDiagnostics {
    policy: IcePolicy;
    stunServers: string[];
    turnServers: string[];
    candidateTypes: string[];
    protocols: string[];
    serverContact: 'none' | 'stun' | 'turn';
}
export declare class DirectSessionManager {
    private readonly opts;
    private currentState;
    private pc;
    private dc;
    private remoteName;
    private remoteFingerprint;
    private pendingSessionId;
    private readonly deliveryReceipts;
    private lastCandidateTypes;
    private lastProtocols;
    constructor(opts: DirectSessionOptions);
    get state(): DirectState;
    get peerName(): string;
    get peerFingerprint(): string;
    get localFingerprint(): string;
    get diagnostics(): DirectDiagnostics;
    receipts(): DirectReceipt[];
    /** Start a session: returns the offer connect-code to hand to the peer. */
    createOffer(): Promise<string>;
    /**
     * Paste a connect code from the peer.
     * - Offer code: joins the session; returns the answer code to send back.
     * - Answer code: completes a session started with {@link createOffer}.
     */
    accept(code: string): Promise<{
        answerCode?: string;
    }>;
    send(content: string): {
        id: string;
    };
    acknowledge(deliveryId: string, status: 'accepted' | 'rejected'): void;
    diagnose(): Promise<DirectDiagnostics>;
    close(): Promise<void>;
    private iceConfig;
    private setState;
    private watchConnection;
    private attachChannel;
    private verifyPeer;
    private captureCandidates;
    private waitIceGathering;
}
export {};
