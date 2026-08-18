import { decodeCode } from './direct/codec.js'
import type { DirectSessionManager } from './direct/session.js'
import type { MessengerService } from './service.js'
import type { IncomingMessage } from './types.js'

interface RendezvousPayload {
  v: 1
  code: string
}

export interface RendezvousEvent {
  at: number
  peer: string
  route?: string
  action: 'offer-sent' | 'offer-accepted' | 'answer-accepted' | 'failed'
  error?: string
}

/** Carries existing signed A2A2 codes through an authenticated sealed mailbox. */
export class RendezvousCoordinator {
  private readonly events: RendezvousEvent[] = []

  constructor(
    private readonly service: MessengerService,
    private readonly direct: DirectSessionManager,
  ) {}

  async call(peer: string, route?: string): Promise<void> {
    const code = await this.direct.createOffer()
    await this.service.send({
      to: peer,
      route,
      kind: 'rendezvous',
      content: JSON.stringify({ v: 1, code } satisfies RendezvousPayload),
    })
    this.record({ at: Date.now(), peer, route, action: 'offer-sent' })
  }

  async handle(message: IncomingMessage): Promise<boolean> {
    if (message.protocol !== 'rendezvous' || message.security !== 'sealed') return false
    let payload: RendezvousPayload
    try {
      const raw = JSON.parse(message.content) as Partial<RendezvousPayload>
      if (raw.v !== 1 || typeof raw.code !== 'string' || !decodeCode(raw.code)) {
        throw new Error('invalid rendezvous payload')
      }
      payload = raw as RendezvousPayload
      const result = await this.direct.accept(payload.code)
      if (result.answerCode) {
        await this.service.send({
          to: message.fromFingerprint ?? message.from,
          route: message.route,
          kind: 'rendezvous',
          content: JSON.stringify({ v: 1, code: result.answerCode } satisfies RendezvousPayload),
        })
        this.record({ at: Date.now(), peer: message.from, route: message.route, action: 'offer-accepted' })
      } else {
        this.record({ at: Date.now(), peer: message.from, route: message.route, action: 'answer-accepted' })
      }
      return true
    } catch (err) {
      this.record({
        at: Date.now(),
        peer: message.from,
        route: message.route,
        action: 'failed',
        error: (err as Error).message,
      })
      throw err
    }
  }

  recentEvents(): RendezvousEvent[] {
    return [...this.events]
  }

  private record(event: RendezvousEvent): void {
    this.events.push(event)
    if (this.events.length > 20) this.events.shift()
  }
}
