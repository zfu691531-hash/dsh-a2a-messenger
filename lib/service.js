import { SseSubscription } from './sse.js';
import { normalizeIncoming } from './teammcp-client.js';
/**
 * Connects the relay to the local quarantine inbox: subscribes to the live
 * SSE stream, and on every (re)connect pulls the relay-side offline inbox so
 * messages sent while this device was offline are not lost. Storage is
 * at-least-once (store locally first, then ack); duplicates are dropped by id.
 */
export class MessengerService {
    opts;
    subscription;
    constructor(opts) {
        this.opts = opts;
    }
    get connectionState() {
        return this.subscription?.state ?? 'idle';
    }
    start() {
        if (this.subscription)
            return;
        this.subscription = new SseSubscription({
            url: this.opts.client.eventsUrl(),
            headers: this.opts.client.authHeaders(),
            fetchImpl: this.opts.client.fetchImpl,
            minDelayMs: this.opts.minRetryMs,
            maxDelayMs: this.opts.maxRetryMs,
            onEvent: (evt) => this.handleEvent(evt),
            onStateChange: (state) => {
                this.opts.onStateChange?.(state);
                if (state === 'connected') {
                    this.catchUp().catch((err) => this.opts.onError?.(err));
                }
            },
        });
        this.subscription.start();
    }
    async stop() {
        await this.subscription?.stop();
        this.subscription = undefined;
    }
    /** Pull the relay-side offline inbox, quarantine everything, then ack. */
    async catchUp() {
        const messages = await this.opts.client.inbox();
        let added = 0;
        for (const msg of messages) {
            if (msg.from === this.opts.selfName)
                continue;
            if (this.opts.inbox.add(msg) === 'added') {
                added++;
                const stored = this.opts.inbox.get(msg.id);
                if (stored)
                    this.opts.onQuarantined?.(stored);
            }
        }
        // Ack only after local storage succeeded (at-least-once delivery).
        await this.opts.client.ackInbox();
        return added;
    }
    handleEvent(evt) {
        if (evt.event !== 'message' && evt.event !== 'dm')
            return;
        let raw;
        try {
            raw = JSON.parse(evt.data);
        }
        catch {
            return;
        }
        const msg = normalizeIncoming(raw);
        if (!msg)
            return;
        if (msg.from === this.opts.selfName)
            return;
        if (this.opts.inbox.add(msg) === 'added') {
            const stored = this.opts.inbox.get(msg.id);
            if (stored)
                this.opts.onQuarantined?.(stored);
        }
    }
}
