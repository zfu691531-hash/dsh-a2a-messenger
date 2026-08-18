import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "a2a-messenger";
export declare const inject: string[];
export interface Config {
    agentName: string;
    transport: 'github' | 'teammcp';
    dataDir: string;
    githubRepo: string;
    githubToken: string;
    githubChannels: string[];
    githubPollSeconds: number;
    serverUrl: string;
    token: string;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { QuarantineInbox } from './inbox.js';
export { MessengerService } from './service.js';
export { SseSubscription } from './sse.js';
export { TeamMcpClient, TeamMcpError, normalizeIncoming } from './teammcp-client.js';
export { GitHubTransport, GitHubTransportError } from './transports/github.js';
export { TeamMcpTransport } from './transports/teammcp.js';
export { DirectSessionManager } from './direct/session.js';
export { decodeCode, encodeCode } from './direct/codec.js';
export { buildCommandDefs, buildToolDefs, formatInjection, parseTarget, } from './surface.js';
export type { Transport, TransportState, TransportSendInput } from './transport.js';
export type { IncomingMessage, QuarantinedMessage, QuarantineStatus } from './types.js';
