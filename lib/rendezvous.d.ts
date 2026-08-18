import type { DirectSessionManager } from './direct/session.js';
import type { MessengerService } from './service.js';
import type { IncomingMessage } from './types.js';
export interface RendezvousEvent {
    at: number;
    peer: string;
    route?: string;
    action: 'offer-sent' | 'offer-accepted' | 'answer-accepted' | 'failed';
    error?: string;
}
/** Carries existing signed A2A2 codes through an authenticated sealed mailbox. */
export declare class RendezvousCoordinator {
    private readonly service;
    private readonly direct;
    private readonly events;
    constructor(service: MessengerService, direct: DirectSessionManager);
    call(peer: string, route?: string): Promise<void>;
    handle(message: IncomingMessage): Promise<boolean>;
    recentEvents(): RendezvousEvent[];
    private record;
}
