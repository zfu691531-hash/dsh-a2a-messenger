import { TeamMcpClient } from '../teammcp-client.js';
import type { Transport, TransportHandlers, TransportPeer, TransportSendInput, TransportState } from '../transport.js';
export interface TeamMcpTransportOptions {
    client: TeamMcpClient;
    /** Own display name; incoming events from this sender are ignored. */
    selfName: string;
    minRetryMs?: number;
    maxRetryMs?: number;
}
/**
 * Self-hosted TeamMCP relay transport: SSE live stream plus relay-side
 * offline inbox catch-up on every (re)connect. Low latency; requires the
 * team to run a relay server.
 */
export declare class TeamMcpTransport implements Transport {
    private readonly opts;
    readonly kind = "teammcp";
    private subscription;
    private handlers;
    constructor(opts: TeamMcpTransportOptions);
    get state(): TransportState;
    start(handlers: TransportHandlers): void;
    stop(): Promise<void>;
    send(input: TransportSendInput): Promise<{
        id?: string;
    }>;
    peers(): Promise<TransportPeer[]>;
    channels(): Promise<string[]>;
    /** Pull the relay-side offline inbox, deliver everything, then ack. */
    catchUp(): Promise<number>;
}
