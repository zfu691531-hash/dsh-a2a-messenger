import type {
  Transport,
  TransportHandlers,
  TransportSendInput,
  TransportState,
} from '../transport.js'

/** Disabled async mailbox used when the plugin runs in direct-only mode. */
export class NoneTransport implements Transport {
  readonly kind = 'none'
  private currentState: TransportState = 'idle'

  get state(): TransportState {
    return this.currentState
  }

  start(handlers: TransportHandlers): void {
    handlers.onStateChange?.(this.currentState)
  }

  async stop(): Promise<void> {
    this.currentState = 'stopped'
  }

  async send(_input: TransportSendInput): Promise<{ id?: string }> {
    throw new Error('async mailbox transport is disabled; use a2a_direct_send')
  }

  async peers(): Promise<[]> {
    return []
  }

  async channels(): Promise<[]> {
    return []
  }
}
