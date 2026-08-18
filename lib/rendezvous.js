import { decodeCode } from './direct/codec.js';
/** Carries existing signed A2A2 codes through an authenticated sealed mailbox. */
export class RendezvousCoordinator {
    service;
    direct;
    events = [];
    constructor(service, direct) {
        this.service = service;
        this.direct = direct;
    }
    async call(peer, route) {
        const code = await this.direct.createOffer();
        await this.service.send({
            to: peer,
            route,
            kind: 'rendezvous',
            content: JSON.stringify({ v: 1, code }),
        });
        this.record({ at: Date.now(), peer, route, action: 'offer-sent' });
    }
    async handle(message) {
        if (message.protocol !== 'rendezvous' || message.security !== 'sealed')
            return false;
        let payload;
        try {
            const raw = JSON.parse(message.content);
            if (raw.v !== 1 || typeof raw.code !== 'string' || !decodeCode(raw.code)) {
                throw new Error('invalid rendezvous payload');
            }
            payload = raw;
            const result = await this.direct.accept(payload.code);
            if (result.answerCode) {
                await this.service.send({
                    to: message.fromFingerprint ?? message.from,
                    route: message.route,
                    kind: 'rendezvous',
                    content: JSON.stringify({ v: 1, code: result.answerCode }),
                });
                this.record({ at: Date.now(), peer: message.from, route: message.route, action: 'offer-accepted' });
            }
            else {
                this.record({ at: Date.now(), peer: message.from, route: message.route, action: 'answer-accepted' });
            }
            return true;
        }
        catch (err) {
            this.record({
                at: Date.now(),
                peer: message.from,
                route: message.route,
                action: 'failed',
                error: err.message,
            });
            throw err;
        }
    }
    recentEvents() {
        return [...this.events];
    }
    record(event) {
        this.events.push(event);
        if (this.events.length > 20)
            this.events.shift();
    }
}
