import { SseSubscription } from '../sse.js'
import { TeamMcpClient } from '../teammcp-client.js'
import { normalizeIncoming } from '../teammcp-client.js'
import type {
  Transport,
  TransportHandlers,
  TransportPeer,
  TransportSendInput,
  TransportState,
} from '../transport.js'

export interface TeamMcpTransportOptions {
  client: TeamMcpClient
  /** Own display name; incoming events from this sender are ignored. */
  selfName: string
  minRetryMs?: number
  maxRetryMs?: number
}

/**
 * Self-hosted TeamMCP relay transport: SSE live stream plus relay-side
 * offline inbox catch-up on every (re)connect. Low latency; requires the
 * team to run a relay server.
 */
export class TeamMcpTransport implements Transport {
  readonly kind = 'teammcp'
  private subscription: SseSubscription | undefined
  private handlers: TransportHandlers | undefined

  constructor(private readonly opts: TeamMcpTransportOptions) {}

  get state(): TransportState {
    return this.subscription?.state ?? 'idle'
  }

  start(handlers: TransportHandlers): void {
    if (this.subscription) return
    this.handlers = handlers
    const { client } = this.opts
    this.subscription = new SseSubscription({
      url: client.eventsUrl(),
      headers: client.authHeaders(),
      fetchImpl: client.fetchImpl,
      minDelayMs: this.opts.minRetryMs,
      maxDelayMs: this.opts.maxRetryMs,
      onEvent: (evt) => {
        if (evt.event !== 'message' && evt.event !== 'dm') return
        let raw: unknown
        try {
          raw = JSON.parse(evt.data)
        } catch {
          return
        }
        const msg = normalizeIncoming(raw)
        if (msg && msg.from !== this.opts.selfName) handlers.onMessage(msg)
      },
      onStateChange: (state) => {
        handlers.onStateChange?.(state)
        if (state === 'connected') {
          this.catchUp().catch((err) => handlers.onError?.(err))
        }
      },
    })
    this.subscription.start()
  }

  async stop(): Promise<void> {
    await this.subscription?.stop()
    this.subscription = undefined
  }

  async send(input: TransportSendInput): Promise<{ id?: string }> {
    const receipt = await this.opts.client.send(input)
    return { id: receipt.id }
  }

  async peers(): Promise<TransportPeer[]> {
    return this.opts.client.agents()
  }

  async channels(): Promise<string[]> {
    return this.opts.client.channels()
  }

  /** Pull the relay-side offline inbox, deliver everything, then ack. */
  async catchUp(): Promise<number> {
    const messages = await this.opts.client.inbox()
    let delivered = 0
    for (const msg of messages) {
      if (msg.from === this.opts.selfName) continue
      this.handlers?.onMessage(msg)
      delivered++
    }
    // Ack only after local delivery ran (at-least-once; inbox dedup drops repeats).
    await this.opts.client.ackInbox()
    return delivered
  }
}
