import type { QuarantineInbox } from './inbox.js';
import type { MessengerService } from './service.js';
import type { TeamMcpClient } from './teammcp-client.js';
import type { QuarantinedMessage } from './types.js';
export declare const PLUGIN_NAME = "a2a-messenger";
export interface AgentLike {
    inject(message: {
        content: string;
        source: {
            kind: 'plugin';
            plugin: string;
        };
    }): void;
}
export interface CommandResultLike {
    kind: 'success' | 'error';
    text?: string;
}
export interface CommandInvocationLike {
    agent: AgentLike;
    rawInput: string;
    signal: AbortSignal;
}
export interface CommandDefinitionLike {
    name: string;
    description: string;
    input?: {
        hint: string;
    };
    handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>;
}
export interface ToolRenderChunk {
    type: 'text';
    text: string;
}
export interface ToolDefinitionLike {
    name: string;
    description: string;
    parameters: Record<string, {
        type: string;
        required?: boolean;
        description: string;
    }>;
    output: {
        schema: {
            type: 'string';
        };
        render: (args: unknown, value: string) => ToolRenderChunk[];
    };
    execute: (args: Record<string, string>) => Promise<string>;
}
/** Parse a send target: `channel:name` / `#name` or `dm:name` / `@name`. */
export declare function parseTarget(target: string): {
    channel?: string;
    to?: string;
} | undefined;
/** Render an accepted message as model-visible context. */
export declare function formatInjection(msg: QuarantinedMessage): string;
export interface ToolDeps {
    client: TeamMcpClient;
    inbox: QuarantineInbox;
    selfName: string;
}
export declare function buildToolDefs(deps: ToolDeps): ToolDefinitionLike[];
export interface CommandDeps {
    inbox: QuarantineInbox;
    service: MessengerService;
    serverUrl: string;
    agentName: string;
}
export declare function buildCommandDefs(deps: CommandDeps): CommandDefinitionLike[];
