import type { IncomingMessage } from './types.js';
/**
 * A transport moves messages between this device and teammates. The plugin
 * treats all transports identically: whatever arrives goes through the local
 * quarantine inbox and needs explicit user approval before the model sees it.
 */
export type TransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'failed';
export interface TransportHandlers {
    onMessage(msg: IncomingMessage): void;
    onStateChange?(state: TransportState): void;
    onError?(err: unknown): void;
}
export interface TransportSendInput {
    channel?: string;
    to?: string;
    content: string;
    /** Explicit route when more than one transport is active. */
    route?: string;
    /** Internal protocol payloads are never shown as ordinary inbox messages. */
    kind?: 'message' | 'rendezvous';
}
export interface TransportPeer {
    name: string;
    online?: boolean;
    role?: string;
}
export interface Transport {
    /** Short identifier shown in status output, e.g. `github` or `teammcp`. */
    readonly kind: string;
    readonly state: TransportState;
    start(handlers: TransportHandlers): void;
    stop(): Promise<void>;
    send(input: TransportSendInput): Promise<{
        id?: string;
    }>;
    /** Optional discovery of teammates; not every transport can enumerate them. */
    peers?(): Promise<TransportPeer[]>;
    /** Optional list of channels this transport is watching. */
    channels?(): Promise<string[]>;
    /** Human-readable operational details without exposing credentials. */
    diagnostics?(): Record<string, unknown>;
}
