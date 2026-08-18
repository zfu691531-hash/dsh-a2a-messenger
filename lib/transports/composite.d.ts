import type { Transport, TransportHandlers, TransportPeer, TransportSendInput, TransportState } from '../transport.js';
/** Runs multiple independent transports; sends only through the selected route. */
export declare class CompositeTransport implements Transport {
    private readonly defaultRoute;
    readonly kind = "multi";
    private readonly routes;
    private readonly states;
    constructor(transports: readonly Transport[], defaultRoute: string);
    get state(): TransportState;
    start(handlers: TransportHandlers): void;
    stop(): Promise<void>;
    send(input: TransportSendInput): Promise<{
        id?: string;
    }>;
    peers(): Promise<TransportPeer[]>;
    channels(): Promise<string[]>;
    diagnostics(): Record<string, unknown>;
}
