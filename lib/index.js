import os from 'node:os';
import path from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { QuarantineInbox } from './inbox.js';
import { MessengerService } from './service.js';
import { buildCommandDefs, buildToolDefs, PLUGIN_NAME } from './surface.js';
import { TeamMcpClient } from './teammcp-client.js';
export const name = PLUGIN_NAME;
export const inject = ['tools', 'commands'];
export const Config = Schema.object({
    serverUrl: Schema.string()
        .required()
        .description('TeamMCP relay base URL, e.g. https://relay.example.com'),
    token: Schema.string()
        .required()
        .role('secret')
        .description('Relay API key from POST /api/register (tmcp_...)'),
    agentName: Schema.string()
        .required()
        .description('This agent\'s display name as registered on the relay'),
    dataDir: Schema.string()
        .default('')
        .description('Quarantine inbox directory; empty means ~/.dsh-a2a-messenger'),
});
export function apply(ctx, config) {
    const c = ctx;
    const dataDir = config.dataDir || path.join(os.homedir(), '.dsh-a2a-messenger');
    const inbox = QuarantineInbox.open(path.join(dataDir, 'inbox.json'));
    const client = new TeamMcpClient({ baseUrl: config.serverUrl, token: config.token });
    const service = new MessengerService({
        client,
        inbox,
        selfName: config.agentName,
        onError: (err) => console.warn(`[${PLUGIN_NAME}]`, err),
    });
    c.effect(() => {
        service.start();
        return () => {
            void service.stop();
        };
    });
    for (const def of buildToolDefs({ client, inbox, selfName: config.agentName })) {
        c.tools.register(defineTool(def));
    }
    for (const def of buildCommandDefs({
        inbox,
        service,
        serverUrl: config.serverUrl,
        agentName: config.agentName,
    })) {
        c.commands.register(def);
    }
}
export { QuarantineInbox } from './inbox.js';
export { MessengerService } from './service.js';
export { SseSubscription } from './sse.js';
export { TeamMcpClient, TeamMcpError, normalizeIncoming } from './teammcp-client.js';
export { buildCommandDefs, buildToolDefs, formatInjection, parseTarget, } from './surface.js';
