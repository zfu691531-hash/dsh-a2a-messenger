import type { Transport, TransportHandlers, TransportSendInput, TransportState } from '../transport.js';
/** Disabled async mailbox used when the plugin runs in direct-only mode. */
export declare class NoneTransport implements Transport {
    readonly kind = "none";
    private currentState;
    get state(): TransportState;
    start(handlers: TransportHandlers): void;
    stop(): Promise<void>;
    send(_input: TransportSendInput): Promise<{
        id?: string;
    }>;
    peers(): Promise<[]>;
    channels(): Promise<[]>;
}
