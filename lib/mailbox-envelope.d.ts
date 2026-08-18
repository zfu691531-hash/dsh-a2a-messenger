import type { ContactStore } from './contacts.js';
import type { DirectIdentity } from './direct/identity.js';
import type { IncomingMessage } from './types.js';
import type { TransportSendInput } from './transport.js';
export interface EnvelopeCodecOptions {
    selfName: string;
    identity: DirectIdentity;
    contacts: ContactStore;
    ttlMs?: number;
    now?: () => number;
    replayFile?: string;
}
export declare class MailboxEnvelopeCodec {
    private readonly opts;
    private readonly now;
    private readonly ttlMs;
    private readonly seen;
    constructor(opts: EnvelopeCodecOptions);
    seal(input: TransportSendInput): string;
    open(value: string): IncomingMessage | undefined;
    static isSealed(value: string): boolean;
    recipientName(selector: string): string;
    private resolveRecipients;
    private encryptFor;
    private decrypt;
    private sharedKey;
    private loadReplayState;
    private pruneReplayState;
    private persistReplayState;
}
