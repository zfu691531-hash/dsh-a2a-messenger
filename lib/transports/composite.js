/** Runs multiple independent transports; sends only through the selected route. */
export class CompositeTransport {
    defaultRoute;
    kind = 'multi';
    routes;
    states = new Map();
    constructor(transports, defaultRoute) {
        this.defaultRoute = defaultRoute;
        const routes = new Map();
        for (const transport of transports) {
            if (routes.has(transport.kind))
                throw new Error(`duplicate transport route "${transport.kind}"`);
            routes.set(transport.kind, transport);
            this.states.set(transport.kind, transport.state);
        }
        if (!routes.has(defaultRoute))
            throw new Error(`default mailbox route "${defaultRoute}" is not configured`);
        this.routes = routes;
    }
    get state() {
        const states = [...this.states.values()];
        if (states.includes('connected'))
            return 'connected';
        if (states.includes('connecting'))
            return 'connecting';
        if (states.includes('reconnecting'))
            return 'reconnecting';
        if (states.includes('failed'))
            return 'failed';
        if (states.every((state) => state === 'stopped'))
            return 'stopped';
        return 'idle';
    }
    start(handlers) {
        for (const [route, transport] of this.routes) {
            transport.start({
                onMessage: (message) => handlers.onMessage({ ...message, route: message.route ?? route }),
                onError: handlers.onError,
                onStateChange: (state) => {
                    this.states.set(route, state);
                    handlers.onStateChange?.(this.state);
                },
            });
        }
    }
    async stop() {
        await Promise.all([...this.routes.values()].map((transport) => transport.stop()));
    }
    send(input) {
        const route = input.route || this.defaultRoute;
        const transport = this.routes.get(route);
        if (!transport)
            throw new Error(`mailbox route "${route}" is not configured`);
        return transport.send({ ...input, route: undefined });
    }
    async peers() {
        const all = await Promise.all([...this.routes.values()].map((transport) => transport.peers?.() ?? []));
        const merged = new Map();
        for (const peers of all)
            for (const peer of peers)
                merged.set(peer.name, peer);
        return [...merged.values()];
    }
    async channels() {
        const all = await Promise.all([...this.routes.values()].map((transport) => transport.channels?.() ?? []));
        return [...new Set(all.flat())];
    }
    diagnostics() {
        return {
            defaultRoute: this.defaultRoute,
            routes: [...this.routes].map(([route, transport]) => ({
                route,
                state: transport.state,
                ...transport.diagnostics?.(),
            })),
            fallback: 'disabled',
        };
    }
}
