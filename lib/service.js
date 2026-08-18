/**
 * Binds a transport to the local quarantine inbox. Every incoming message —
 * regardless of transport — is persisted as pending and stays model-invisible
 * until the user approves it. Duplicates are dropped by message id.
 */
export class MessengerService {
    opts;
    started = false;
    constructor(opts) {
        this.opts = opts;
    }
    get connectionState() {
        return this.opts.transport.state;
    }
    get transportKind() {
        return this.opts.transport.kind;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.opts.transport.start({
            onMessage: (msg) => this.intake(msg),
            onStateChange: (state) => this.opts.onStateChange?.(state),
            onError: (err) => this.opts.onError?.(err),
        });
    }
    async stop() {
        if (!this.started)
            return;
        this.started = false;
        await this.opts.transport.stop();
    }
    async send(input) {
        return this.opts.transport.send(input);
    }
    async peers() {
        return (await this.opts.transport.peers?.()) ?? [];
    }
    async channels() {
        return (await this.opts.transport.channels?.()) ?? [];
    }
    /** Quarantine one incoming message from any source (transport or direct session). */
    intake(msg) {
        if (msg.from === this.opts.selfName)
            return;
        if (this.opts.inbox.add(msg) === 'added') {
            const stored = this.opts.inbox.get(msg.id);
            if (stored)
                this.opts.onQuarantined?.(stored);
        }
    }
}
