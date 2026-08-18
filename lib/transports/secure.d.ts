import { MailboxEnvelopeCodec } from '../mailbox-envelope.js';
import type { Transport, TransportHandlers, TransportPeer, TransportSendInput, TransportState } from '../transport.js';
export type MailboxSecurity = 'readable' | 'sealed';
/** Applies one fail-closed visibility policy to any mailbox transport. */
export declare class SecureTransport implements Transport {
    private readonly inner;
    private readonly mode;
    private readonly codec;
    constructor(inner: Transport, mode: MailboxSecurity, codec: MailboxEnvelopeCodec);
    get kind(): string;
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
