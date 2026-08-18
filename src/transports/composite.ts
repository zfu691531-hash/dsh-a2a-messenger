import type {
  Transport,
  TransportHandlers,
  TransportPeer,
  TransportSendInput,
  TransportState,
} from '../transport.js'

/** Runs multiple independent transports; sends only through the selected route. */
export class CompositeTransport implements Transport {
  readonly kind = 'multi'
  private readonly routes: ReadonlyMap<string, Transport>
  private readonly states = new Map<string, TransportState>()

  constructor(transports: readonly Transport[], private readonly defaultRoute: string) {
    const routes = new Map<string, Transport>()
    for (const transport of transports) {
      if (routes.has(transport.kind)) throw new Error(`duplicate transport route "${transport.kind}"`)
      routes.set(transport.kind, transport)
      this.states.set(transport.kind, transport.state)
    }
    if (!routes.has(defaultRoute)) throw new Error(`default mailbox route "${defaultRoute}" is not configured`)
    this.routes = routes
  }

  get state(): TransportState {
    const states = [...this.states.values()]
    if (states.includes('connected')) return 'connected'
    if (states.includes('connecting')) return 'connecting'
    if (states.includes('reconnecting')) return 'reconnecting'
    if (states.includes('failed')) return 'failed'
    if (states.every((state) => state === 'stopped')) return 'stopped'
    return 'idle'
  }

  start(handlers: TransportHandlers): void {
    for (const [route, transport] of this.routes) {
      transport.start({
        onMessage: (message) => handlers.onMessage({ ...message, route: message.route ?? route }),
        onError: handlers.onError,
        onStateChange: (state) => {
          this.states.set(route, state)
          handlers.onStateChange?.(this.state)
        },
      })
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.routes.values()].map((transport) => transport.stop()))
  }

  send(input: TransportSendInput): Promise<{ id?: string }> {
    const route = input.route || this.defaultRoute
    const transport = this.routes.get(route)
    if (!transport) throw new Error(`mailbox route "${route}" is not configured`)
    return transport.send({ ...input, route: undefined })
  }

  async peers(): Promise<TransportPeer[]> {
    const all = await Promise.all([...this.routes.values()].map((transport) => transport.peers?.() ?? []))
    const merged = new Map<string, TransportPeer>()
    for (const peers of all) for (const peer of peers) merged.set(peer.name, peer)
    return [...merged.values()]
  }

  async channels(): Promise<string[]> {
    const all = await Promise.all([...this.routes.values()].map((transport) => transport.channels?.() ?? []))
    return [...new Set(all.flat())]
  }

  diagnostics(): Record<string, unknown> {
    return {
      defaultRoute: this.defaultRoute,
      routes: [...this.routes].map(([route, transport]) => ({
        route,
        state: transport.state,
        ...transport.diagnostics?.(),
      })),
      fallback: 'disabled',
    }
  }
}
