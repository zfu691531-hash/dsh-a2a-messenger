import { MailboxEnvelopeCodec } from '../mailbox-envelope.js';
/** Applies one fail-closed visibility policy to any mailbox transport. */
export class SecureTransport {
    inner;
    mode;
    codec;
    constructor(inner, mode, codec) {
        this.inner = inner;
        this.mode = mode;
        this.codec = codec;
    }
    get kind() {
        return this.inner.kind;
    }
    get state() {
        return this.inner.state;
    }
    start(handlers) {
        this.inner.start({
            ...handlers,
            onMessage: (message) => {
                const sealed = MailboxEnvelopeCodec.isSealed(message.content);
                if (!sealed) {
                    if (this.mode === 'sealed') {
                        handlers.onError?.(new Error(`refused readable message on sealed ${this.inner.kind} route`));
                        return;
                    }
                    handlers.onMessage({ ...message, security: 'readable', route: this.inner.kind });
                    return;
                }
                try {
                    const opened = this.codec.open(message.content);
                    if (opened)
                        handlers.onMessage({ ...opened, route: this.inner.kind });
                }
                catch (err) {
                    handlers.onError?.(err);
                }
            },
        });
    }
    stop() {
        return this.inner.stop();
    }
    send(input) {
        if (input.kind === 'rendezvous' && this.mode !== 'sealed') {
            throw new Error(`automatic rendezvous requires a sealed ${this.inner.kind} route`);
        }
        if (this.mode === 'readable')
            return this.inner.send(input);
        const content = this.codec.seal(input);
        if (input.to && this.inner.kind === 'teammcp') {
            return this.inner.send({
                ...input,
                to: this.codec.recipientName(input.to),
                content,
            });
        }
        return this.inner.send({
            ...input,
            content,
            ...(input.to ? { channel: '__mailbox__', to: undefined } : {}),
        });
    }
    peers() {
        return this.inner.peers?.() ?? Promise.resolve([]);
    }
    channels() {
        return this.inner.channels?.() ?? Promise.resolve([]);
    }
    diagnostics() {
        return { ...this.inner.diagnostics?.(), security: this.mode };
    }
}
