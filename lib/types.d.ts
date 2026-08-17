/** A message received from the team relay, normalized to one shape. */
export interface IncomingMessage {
    /** Stable unique id used for deduplication. */
    id: string;
    /** Sender display name as registered on the relay. */
    from: string;
    /** Channel name; undefined means a direct message. */
    channel?: string;
    /** Plain-text message body. */
    content: string;
    /** Sender-side timestamp, epoch milliseconds. */
    ts: number;
}
export type QuarantineStatus = 'pending' | 'accepted' | 'rejected';
/** An incoming message held in the local quarantine inbox. */
export interface QuarantinedMessage extends IncomingMessage {
    receivedAt: number;
    status: QuarantineStatus;
    decidedAt?: number;
}
