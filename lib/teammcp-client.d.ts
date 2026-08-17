import type { IncomingMessage } from './types.js';
/**
 * Minimal HTTP client for a TeamMCP relay (https://github.com/cookjohn/teammcp).
 * Only the endpoints this plugin needs are covered. Response shapes are
 * normalized defensively because TeamMCP documents endpoints, not schemas;
 * the mapping is verified against test/mock-teammcp-server.mjs and must be
 * re-checked against a real server during two-device validation.
 */
export interface TeamMcpClientOptions {
    /** Relay base URL, e.g. `https://relay.example.com`. */
    baseUrl: string;
    /** Bearer token issued by `POST /api/register` (`tmcp_...`). */
    token: string;
    fetchImpl?: typeof fetch;
}
export declare class TeamMcpError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export interface SendInput {
    /** Target channel name. Mutually exclusive with `to`. */
    channel?: string;
    /** Target agent name for a direct message. Mutually exclusive with `channel`. */
    to?: string;
    content: string;
}
export interface SendReceipt {
    id?: string;
    ts?: number;
}
export interface PeerInfo {
    name: string;
    online?: boolean;
    role?: string;
}
export interface RegisterInput {
    name: string;
    role?: string;
    secret?: string;
}
export interface RegisterResult {
    apiKey: string;
    agent?: {
        name?: string;
        role?: string;
    };
}
/** Normalize one relay message object; returns undefined for unusable input. */
export declare function normalizeIncoming(raw: unknown): IncomingMessage | undefined;
export declare class TeamMcpClient {
    private readonly baseUrl;
    private readonly token;
    readonly fetchImpl: typeof fetch;
    constructor(options: TeamMcpClientOptions);
    authHeaders(): Record<string, string>;
    eventsUrl(): string;
    private request;
    health(): Promise<boolean>;
    send(input: SendInput): Promise<SendReceipt>;
    inbox(): Promise<IncomingMessage[]>;
    ackInbox(): Promise<void>;
    agents(): Promise<PeerInfo[]>;
    channels(): Promise<string[]>;
    /** Register a new agent identity on the relay. Requires no prior token. */
    static register(baseUrl: string, input: RegisterInput, fetchImpl?: typeof fetch): Promise<RegisterResult>;
}
