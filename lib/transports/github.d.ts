import type { Transport, TransportHandlers, TransportPeer, TransportSendInput, TransportState } from '../transport.js';
export interface GitHubTransportOptions {
    /** Team repository, `owner/name`. Should be private. */
    repo: string;
    /** Token with repo scope (classic) or Issues read/write (fine-grained). */
    token: string;
    /** Channel names to watch; each maps to one issue titled `a2a: <name>`. */
    channels: string[];
    /** Poll interval in milliseconds. Default 30 000, minimum 5 000. */
    pollIntervalMs?: number;
    /** File where the poll cursor is persisted across restarts. */
    cursorFile?: string;
    /** How far back to read on the very first start. Default 1 hour. */
    backfillMs?: number;
    /** Override the API base URL (tests point this at the mock server). */
    apiBase?: string;
    fetchImpl?: typeof fetch;
}
export declare class GitHubTransportError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
/**
 * Zero-deployment mailbox transport on top of a private GitHub repository.
 * Each channel is one issue (`a2a: <name>`, labelled `a2a-channel`) and each
 * message is one issue comment, so identity, access control (collaborators),
 * offline storage, and a human-readable web UI all come from GitHub itself.
 * Delivery is polling-based: expect seconds of latency, not real time.
 */
export declare class GitHubTransport implements Transport {
    private readonly opts;
    readonly kind = "github";
    private currentState;
    private handlers;
    private timer;
    private stopped;
    private selfLogin;
    private readonly issueByChannel;
    private cursor;
    private readonly pollIntervalMs;
    private readonly fetchImpl;
    private readonly apiBase;
    constructor(opts: GitHubTransportOptions);
    get state(): TransportState;
    get login(): string;
    start(handlers: TransportHandlers): void;
    stop(): Promise<void>;
    send(input: TransportSendInput): Promise<{
        id?: string;
    }>;
    peers(): Promise<TransportPeer[]>;
    channels(): Promise<string[]>;
    private setState;
    private run;
    private init;
    private pollLoop;
    /** One poll pass over every watched channel. Exposed for tests. */
    pollOnce(): Promise<number>;
    private normalizeComment;
    private ensureChannelIssue;
    private request;
    private loadCursor;
    private saveCursor;
}
