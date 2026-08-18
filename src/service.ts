import type { AddResult, QuarantineInbox } from './inbox.js'
import type { Transport, TransportSendInput, TransportState } from './transport.js'
import type { QuarantinedMessage } from './types.js'

export interface MessengerServiceOptions {
  transport: Transport
  inbox: QuarantineInbox
  /** Own display name; used as a final self-echo filter. */
  selfName: string
  onQuarantined?: (msg: QuarantinedMessage) => void
  onStateChange?: (state: TransportState) => void
  onError?: (err: unknown) => void
}

/**
 * Binds a transport to the local quarantine inbox. Every incoming message —
 * regardless of transport — is persisted as pending and stays model-invisible
 * until the user approves it. Duplicates are dropped by message id.
 */
export class MessengerService {
  private started = false
  private protocolHandler: ((msg: QuarantinedMessage) => boolean | Promise<boolean>) | undefined

  constructor(private readonly opts: MessengerServiceOptions) {}

  get connectionState(): TransportState {
    return this.opts.transport.state
  }

  get transportKind(): string {
    return this.opts.transport.kind
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.opts.transport.start({
      onMessage: (msg) => {
        if (msg.protocol && this.protocolHandler) {
          void Promise.resolve(this.protocolHandler({ ...msg, receivedAt: Date.now(), status: 'pending' }))
            .catch((err) => this.opts.onError?.(err))
          return
        }
        this.intake(msg)
      },
      onStateChange: (state) => this.opts.onStateChange?.(state),
      onError: (err) => this.opts.onError?.(err),
    })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.opts.transport.stop()
  }

  async send(input: TransportSendInput): Promise<{ id?: string }> {
    return this.opts.transport.send(input)
  }

  async peers(): Promise<{ name: string; online?: boolean; role?: string }[]> {
    return (await this.opts.transport.peers?.()) ?? []
  }

  async channels(): Promise<string[]> {
    return (await this.opts.transport.channels?.()) ?? []
  }

  /** Quarantine one incoming message from any source (transport or direct session). */
  intake(msg: { id: string; from: string; fromFingerprint?: string; channel?: string; content: string; ts: number; route?: string; security?: 'readable' | 'sealed' | 'direct'; protocol?: 'rendezvous'; deliveryId?: string }): AddResult | 'self' {
    if (msg.from === this.opts.selfName) return 'self'
    const result = this.opts.inbox.add(msg)
    if (result === 'added') {
      const stored = this.opts.inbox.get(msg.id)
      if (stored) this.opts.onQuarantined?.(stored)
    }
    return result
  }

  setProtocolHandler(handler: (msg: QuarantinedMessage) => boolean | Promise<boolean>): void {
    this.protocolHandler = handler
  }

  diagnostics(): Record<string, unknown> {
    return this.opts.transport.diagnostics?.() ?? {
      route: this.opts.transport.kind,
      state: this.opts.transport.state,
    }
  }
}
