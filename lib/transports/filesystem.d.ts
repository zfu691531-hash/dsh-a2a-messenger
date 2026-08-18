import type { Transport, TransportHandlers, TransportSendInput, TransportState } from '../transport.js';
export interface FilesystemTransportOptions {
    directory: string;
    selfName: string;
    pollIntervalMs?: number;
    backfillMs?: number;
}
/** Shared-folder mailbox for Syncthing, OneDrive, NAS, or removable media. */
export declare class FilesystemTransport implements Transport {
    private readonly opts;
    readonly kind = "filesystem";
    private currentState;
    private handlers;
    private timer;
    private readonly seen;
    private readonly messagesDir;
    private readonly pollIntervalMs;
    private readonly cutoff;
    private stopped;
    constructor(opts: FilesystemTransportOptions);
    get state(): TransportState;
    start(handlers: TransportHandlers): void;
    stop(): Promise<void>;
    send(input: TransportSendInput): Promise<{
        id?: string;
    }>;
    pollOnce(): Promise<number>;
    channels(): Promise<string[]>;
    diagnostics(): Record<string, unknown>;
    private tick;
    private setState;
}
