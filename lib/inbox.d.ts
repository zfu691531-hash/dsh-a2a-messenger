import type { IncomingMessage, QuarantinedMessage, QuarantineStatus } from './types.js';
export type AddResult = 'added' | 'duplicate' | 'rejected-too-large' | 'rejected-inbox-full';
export interface QuarantineInboxOptions {
    /** Maximum number of pending messages held at once. */
    maxPending?: number;
    /** Maximum accepted content size per message, in bytes. */
    maxContentBytes?: number;
    /** Maximum number of decided (accepted/rejected) records kept for dedup. */
    maxDecided?: number;
}
/**
 * Persistent quarantine inbox. Incoming messages are stored here and are
 * NEVER model-visible until the local user explicitly accepts them.
 * Backed by a single JSON file written atomically (tmp file + rename).
 */
export declare class QuarantineInbox {
    private readonly filePath;
    private readonly items;
    private readonly maxPending;
    private readonly maxContentBytes;
    private readonly maxDecided;
    private constructor();
    static open(filePath: string, options?: QuarantineInboxOptions): QuarantineInbox;
    add(msg: IncomingMessage): AddResult;
    get(id: string): QuarantinedMessage | undefined;
    listPending(): QuarantinedMessage[];
    pendingCount(): number;
    accept(id: string): QuarantinedMessage | undefined;
    reject(id: string): QuarantinedMessage | undefined;
    /** Decide every pending message at once; returns the affected messages. */
    decideAll(status: Exclude<QuarantineStatus, 'pending'>): QuarantinedMessage[];
    private decide;
    private persist;
    private pruneDecided;
}
