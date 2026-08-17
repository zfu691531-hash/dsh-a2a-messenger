import type { QuarantineInbox } from './inbox.js';
import { type SseState } from './sse.js';
import { type TeamMcpClient } from './teammcp-client.js';
import type { QuarantinedMessage } from './types.js';
export interface MessengerServiceOptions {
    client: TeamMcpClient;
    inbox: QuarantineInbox;
    /** Own display name; incoming events from this sender are ignored. */
    selfName: string;
    onQuarantined?: (msg: QuarantinedMessage) => void;
    onStateChange?: (state: SseState) => void;
    onError?: (err: unknown) => void;
    minRetryMs?: number;
    maxRetryMs?: number;
}
/**
 * Connects the relay to the local quarantine inbox: subscribes to the live
 * SSE stream, and on every (re)connect pulls the relay-side offline inbox so
 * messages sent while this device was offline are not lost. Storage is
 * at-least-once (store locally first, then ack); duplicates are dropped by id.
 */
export declare class MessengerService {
    private readonly opts;
    private subscription;
    constructor(opts: MessengerServiceOptions);
    get connectionState(): SseState;
    start(): void;
    stop(): Promise<void>;
    /** Pull the relay-side offline inbox, quarantine everything, then ack. */
    catchUp(): Promise<number>;
    private handleEvent;
}
