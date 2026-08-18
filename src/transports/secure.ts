import { MailboxEnvelopeCodec } from '../mailbox-envelope.js'
import type {
  Transport,
  TransportHandlers,
  TransportPeer,
  TransportSendInput,
  TransportState,
} from '../transport.js'

export type MailboxSecurity = 'readable' | 'sealed'

/** Applies one fail-closed visibility policy to any mailbox transport. */
export class SecureTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly mode: MailboxSecurity,
    private readonly codec: MailboxEnvelopeCodec,
  ) {}

  get kind(): string {
    return this.inner.kind
  }

  get state(): TransportState {
    return this.inner.state
  }

  start(handlers: TransportHandlers): void {
    this.inner.start({
      ...handlers,
      onMessage: (message) => {
        const sealed = MailboxEnvelopeCodec.isSealed(message.content)
        if (!sealed) {
          if (this.mode === 'sealed') {
            handlers.onError?.(new Error(`refused readable message on sealed ${this.inner.kind} route`))
            return
          }
          handlers.onMessage({ ...message, security: 'readable', route: this.inner.kind })
          return
        }
        try {
          const opened = this.codec.open(message.content)
          if (opened) handlers.onMessage({ ...opened, route: this.inner.kind })
        } catch (err) {
          handlers.onError?.(err)
        }
      },
    })
  }

  stop(): Promise<void> {
    return this.inner.stop()
  }

  send(input: TransportSendInput): Promise<{ id?: string }> {
    if (input.kind === 'rendezvous' && this.mode !== 'sealed') {
      throw new Error(`automatic rendezvous requires a sealed ${this.inner.kind} route`)
    }
    if (this.mode === 'readable') return this.inner.send(input)
    const content = this.codec.seal(input)
    if (input.to && this.inner.kind === 'teammcp') {
      return this.inner.send({
        ...input,
        to: this.codec.recipientName(input.to),
        content,
      })
    }
    return this.inner.send({
      ...input,
      content,
      ...(input.to ? { channel: '__mailbox__', to: undefined } : {}),
    })
  }

  peers(): Promise<TransportPeer[]> {
    return this.inner.peers?.() ?? Promise.resolve([])
  }

  channels(): Promise<string[]> {
    return this.inner.channels?.() ?? Promise.resolve([])
  }

  diagnostics(): Record<string, unknown> {
    return { ...this.inner.diagnostics?.(), security: this.mode }
  }
}
