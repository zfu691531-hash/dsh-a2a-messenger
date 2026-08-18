import { SseSubscription } from '../sse.js';
import { normalizeIncoming } from '../teammcp-client.js';
/**
 * Self-hosted TeamMCP relay transport: SSE live stream plus relay-side
 * offline inbox catch-up on every (re)connect. Low latency; requires the
 * team to run a relay server.
 */
export class TeamMcpTransport {
    opts;
    kind = 'teammcp';
    subscription;
    handlers;
    constructor(opts) {
        this.opts = opts;
    }
    get state() {
        return this.subscription?.state ?? 'idle';
    }
    start(handlers) {
        if (this.subscription)
            return;
        this.handlers = handlers;
        const { client } = this.opts;
        this.subscription = new SseSubscription({
            url: client.eventsUrl(),
            headers: client.authHeaders(),
            fetchImpl: client.fetchImpl,
            minDelayMs: this.opts.minRetryMs,
            maxDelayMs: this.opts.maxRetryMs,
            onEvent: (evt) => {
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
                if (msg && msg.from !== this.opts.selfName)
                    handlers.onMessage(msg);
            },
            onStateChange: (state) => {
                handlers.onStateChange?.(state);
                if (state === 'connected') {
                    this.catchUp().catch((err) => handlers.onError?.(err));
                }
            },
        });
        this.subscription.start();
    }
    async stop() {
        await this.subscription?.stop();
        this.subscription = undefined;
    }
    async send(input) {
        const receipt = await this.opts.client.send(input);
        return { id: receipt.id };
    }
    async peers() {
        return this.opts.client.agents();
    }
    async channels() {
        return this.opts.client.channels();
    }
    /** Pull the relay-side offline inbox, deliver everything, then ack. */
    async catchUp() {
        const messages = await this.opts.client.inbox();
        let delivered = 0;
        for (const msg of messages) {
            if (msg.from === this.opts.selfName)
                continue;
            this.handlers?.onMessage(msg);
            delivered++;
        }
        // Ack only after local delivery ran (at-least-once; inbox dedup drops repeats).
        await this.opts.client.ackInbox();
        return delivered;
    }
}
