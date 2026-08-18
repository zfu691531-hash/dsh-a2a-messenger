/** A message received from the team relay, normalized to one shape. */
export interface IncomingMessage {
    /** Stable unique id used for deduplication. */
    id: string;
    /** Sender display name as registered on the relay. */
    from: string;
    /** Authenticated signing fingerprint when the transport provides one. */
    fromFingerprint?: string;
    /** Channel name; undefined means a direct message. */
    channel?: string;
    /** Plain-text message body. */
    content: string;
    /** Sender-side timestamp, epoch milliseconds. */
    ts: number;
    /** Transport route that delivered the message. */
    route?: string;
    /** Content visibility on the backing mailbox. */
    security?: 'readable' | 'sealed' | 'direct';
    /** Authenticated internal protocol message handled before quarantine. */
    protocol?: 'rendezvous';
    /** Sender-side id used for direct delivery status updates. */
    deliveryId?: string;
}
export type QuarantineStatus = 'pending' | 'accepted' | 'rejected';
/** An incoming message held in the local quarantine inbox. */
export interface QuarantinedMessage extends IncomingMessage {
    receivedAt: number;
    status: QuarantineStatus;
    decidedAt?: number;
}
