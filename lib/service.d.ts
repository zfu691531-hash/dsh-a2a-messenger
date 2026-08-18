import type { QuarantineInbox } from './inbox.js';
import type { Transport, TransportSendInput, TransportState } from './transport.js';
import type { QuarantinedMessage } from './types.js';
export interface MessengerServiceOptions {
    transport: Transport;
    inbox: QuarantineInbox;
    /** Own display name; used as a final self-echo filter. */
    selfName: string;
    onQuarantined?: (msg: QuarantinedMessage) => void;
    onStateChange?: (state: TransportState) => void;
    onError?: (err: unknown) => void;
}
/**
 * Binds a transport to the local quarantine inbox. Every incoming message —
 * regardless of transport — is persisted as pending and stays model-invisible
 * until the user approves it. Duplicates are dropped by message id.
 */
export declare class MessengerService {
    private readonly opts;
    private started;
    constructor(opts: MessengerServiceOptions);
    get connectionState(): TransportState;
    get transportKind(): string;
    start(): void;
    stop(): Promise<void>;
    send(input: TransportSendInput): Promise<{
        id?: string;
    }>;
    peers(): Promise<{
        name: string;
        online?: boolean;
        role?: string;
    }[]>;
    channels(): Promise<string[]>;
    /** Quarantine one incoming message from any source (transport or direct session). */
    intake(msg: {
        id: string;
        from: string;
        channel?: string;
        content: string;
        ts: number;
    }): void;
}
