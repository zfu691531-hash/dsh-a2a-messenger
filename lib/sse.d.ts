/** One parsed Server-Sent Event. */
export interface SseEvent {
    event: string;
    data: string;
}
export type SseState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';
export interface SseSubscriptionOptions {
    url: string;
    headers?: Record<string, string>;
    onEvent: (evt: SseEvent) => void;
    onStateChange?: (state: SseState) => void;
    fetchImpl?: typeof fetch;
    /** First reconnect delay; doubles per failure. */
    minDelayMs?: number;
    /** Reconnect delay cap. */
    maxDelayMs?: number;
}
/**
 * A long-lived SSE subscription with exponential-backoff reconnect.
 * `start()` returns immediately; events arrive on `onEvent` until `stop()`.
 */
export declare class SseSubscription {
    private readonly opts;
    private stopped;
    private controller;
    private loopPromise;
    private currentState;
    constructor(opts: SseSubscriptionOptions);
    get state(): SseState;
    start(): void;
    stop(): Promise<void>;
    private setState;
    private loop;
    private readStream;
}
