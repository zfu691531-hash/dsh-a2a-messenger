import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "a2a-messenger";
export declare const inject: string[];
export interface Config {
    serverUrl: string;
    token: string;
    agentName: string;
    dataDir: string;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { QuarantineInbox } from './inbox.js';
export { MessengerService } from './service.js';
export { SseSubscription } from './sse.js';
export { TeamMcpClient, TeamMcpError, normalizeIncoming } from './teammcp-client.js';
export { buildCommandDefs, buildToolDefs, formatInjection, parseTarget, } from './surface.js';
export type { IncomingMessage, QuarantinedMessage, QuarantineStatus } from './types.js';
