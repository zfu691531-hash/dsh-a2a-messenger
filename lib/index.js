import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DirectSessionManager } from './direct/session.js';
import { openDirectIdentity } from './direct/identity.js';
import { ContactStore } from './contacts.js';
import { MailboxEnvelopeCodec } from './mailbox-envelope.js';
import { QuarantineInbox } from './inbox.js';
import { MessengerService } from './service.js';
import { buildCommandDefs, buildToolDefs, PLUGIN_NAME } from './surface.js';
import { TeamMcpClient } from './teammcp-client.js';
import { GitHubTransport } from './transports/github.js';
import { NoneTransport } from './transports/none.js';
import { CompositeTransport } from './transports/composite.js';
import { FilesystemTransport } from './transports/filesystem.js';
import { SecureTransport } from './transports/secure.js';
import { TeamMcpTransport } from './transports/teammcp.js';
import { RendezvousCoordinator } from './rendezvous.js';
export const name = PLUGIN_NAME;
export const inject = ['tools', 'commands'];
export const Config = Schema.object({
    agentName: Schema.string()
        .required()
        .description('Your display name shown to teammates'),
    deviceName: Schema.string()
        .default(os.hostname())
        .description('This device label; identity remains stable if the display name changes'),
    transport: Schema.union(['none', 'github', 'filesystem', 'teammcp'])
        .default('github')
        .description('Primary async mailbox transport: "none", "github", "filesystem", or "teammcp"'),
    dataDir: Schema.string()
        .default('')
        .description('Local state directory; empty means ~/.dsh-a2a-messenger'),
    trustedPeers: Schema.array(Schema.string())
        .default([])
        .description('Direct peers allowed to connect, each as "expected-name=ed25519:fingerprint"'),
    githubRepo: Schema.string()
        .default('')
        .description('github transport: private team repository, e.g. "myteam/a2a-inbox"'),
    githubToken: Schema.string()
        .default('')
        .role('secret')
        .description('github transport: token; empty tries GITHUB_TOKEN / GH_TOKEN env, then `gh auth token`'),
    githubChannels: Schema.array(Schema.string())
        .default(['general'])
        .description('github transport: channel names to watch'),
    githubPollSeconds: Schema.number()
        .default(30)
        .description('github transport: poll interval in seconds (minimum 5)'),
    filesystemDir: Schema.string()
        .default('')
        .description('Shared mailbox directory (Syncthing/OneDrive/NAS); also enables it beside the primary route'),
    filesystemPollSeconds: Schema.number()
        .default(5)
        .description('filesystem transport: poll interval in seconds (minimum 1)'),
    mailboxEncryption: Schema.union(['readable', 'sealed'])
        .default('readable')
        .description('Mailbox visibility: readable compatibility mode or fail-closed end-to-end sealed mode'),
    mailboxRoute: Schema.string()
        .default('')
        .description('Default route when multiple transports are active; empty uses the primary transport'),
    mailboxTtlHours: Schema.number()
        .default(168)
        .description('Sealed async message lifetime in hours; automatic rendezvous is always limited to 10 minutes'),
    directIcePolicy: Schema.union(['strict', 'stun', 'relay'])
        .default('stun')
        .description('strict=host candidates only, stun=direct NAT traversal, relay=TURN-only'),
    stunServers: Schema.array(Schema.string())
        .default(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'])
        .description('STUN URLs used only by the stun ICE policy'),
    turnServers: Schema.array(Schema.string())
        .default([])
        .description('TURN URLs used only by the relay ICE policy; no relay is bundled'),
    turnUsername: Schema.string().default('').description('TURN username'),
    turnCredential: Schema.string().default('').role('secret').description('TURN credential'),
    serverUrl: Schema.string()
        .default('')
        .description('teammcp transport: relay base URL, e.g. https://relay.example.com'),
    token: Schema.string()
        .default('')
        .role('secret')
        .description('teammcp transport: relay API key from POST /api/register (tmcp_...)'),
});
function resolveGitHubToken(configured) {
    if (configured)
        return configured;
    const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (env)
        return env;
    try {
        const fromCli = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (fromCli)
            return fromCli;
    }
    catch {
        // gh CLI absent or not logged in.
    }
    throw new Error(`[${PLUGIN_NAME}] github transport needs a token: set githubToken in the plugin config, ` +
        'or export GITHUB_TOKEN, or log in with `gh auth login`');
}
export function parseTrustedPeers(entries) {
    const peers = new Map();
    const fingerprintsByName = new Map();
    for (const entry of entries) {
        const separator = entry.indexOf('=');
        const name = separator > 0 ? entry.slice(0, separator).trim() : '';
        const fingerprint = separator > 0 ? entry.slice(separator + 1).trim() : '';
        if (!name || !/^ed25519:[A-Za-z0-9_-]{43}$/.test(fingerprint)) {
            throw new Error(`[${PLUGIN_NAME}] invalid trustedPeers entry "${entry}"; expected "name=ed25519:fingerprint"`);
        }
        const existingName = peers.get(fingerprint);
        if (existingName && existingName !== name) {
            throw new Error(`[${PLUGIN_NAME}] fingerprint ${fingerprint} is assigned to multiple names`);
        }
        const existingFingerprint = fingerprintsByName.get(name);
        if (existingFingerprint && existingFingerprint !== fingerprint) {
            throw new Error(`[${PLUGIN_NAME}] peer name "${name}" is assigned to multiple fingerprints`);
        }
        peers.set(fingerprint, name);
        fingerprintsByName.set(name, fingerprint);
    }
    return peers;
}
export function buildTransport(config, dataDir, security) {
    if (config.transport === 'none')
        return new NoneTransport();
    const transports = [];
    if (config.transport === 'teammcp') {
        if (!config.serverUrl || !config.token) {
            throw new Error(`[${PLUGIN_NAME}] teammcp transport needs serverUrl and token in the plugin config`);
        }
        transports.push(new TeamMcpTransport({
            client: new TeamMcpClient({ baseUrl: config.serverUrl, token: config.token }),
            selfName: config.agentName,
        }));
    }
    else if (config.transport === 'filesystem') {
        if (!config.filesystemDir)
            throw new Error(`[${PLUGIN_NAME}] filesystem transport needs filesystemDir`);
    }
    else {
        if (!config.githubRepo) {
            throw new Error(`[${PLUGIN_NAME}] github transport needs githubRepo ("owner/name") in the plugin config`);
        }
        transports.push(new GitHubTransport({
            repo: config.githubRepo,
            token: resolveGitHubToken(config.githubToken),
            channels: config.githubChannels.length > 0 ? config.githubChannels : ['general'],
            pollIntervalMs: config.githubPollSeconds * 1000,
            cursorFile: path.join(dataDir, 'github-cursor.json'),
        }));
    }
    if (config.filesystemDir) {
        transports.push(new FilesystemTransport({
            directory: config.filesystemDir,
            selfName: config.agentName,
            pollIntervalMs: (config.filesystemPollSeconds ?? 5) * 1000,
        }));
    }
    const protectedTransports = security
        ? transports.map((transport) => new SecureTransport(transport, security.mode, security.codec))
        : transports;
    if (protectedTransports.length === 1)
        return protectedTransports[0];
    const primaryRoute = config.transport === 'filesystem' ? 'filesystem' : config.transport;
    return new CompositeTransport(protectedTransports, config.mailboxRoute || primaryRoute);
}
export function apply(ctx, config) {
    const c = ctx;
    const dataDir = config.dataDir || path.join(os.homedir(), '.dsh-a2a-messenger');
    const inbox = QuarantineInbox.open(path.join(dataDir, 'inbox.json'));
    const identity = openDirectIdentity(path.join(dataDir, 'direct-identity.json'));
    const contacts = ContactStore.open(path.join(dataDir, 'contacts.json'));
    contacts.importLegacy(parseTrustedPeers(config.trustedPeers ?? []));
    const envelopeCodec = new MailboxEnvelopeCodec({
        selfName: config.agentName,
        identity,
        contacts,
        ttlMs: Math.max(1, config.mailboxTtlHours ?? 168) * 60 * 60 * 1000,
        replayFile: path.join(dataDir, 'mailbox-replay.json'),
    });
    const transport = buildTransport(config, dataDir, {
        codec: envelopeCodec,
        mode: config.mailboxEncryption ?? 'readable',
    });
    const service = new MessengerService({
        transport,
        inbox,
        selfName: config.agentName,
        onError: (err) => console.warn(`[${PLUGIN_NAME}]`, err),
    });
    const direct = new DirectSessionManager({
        selfName: config.agentName,
        identity,
        trustedPeers: () => contacts.trustedPeers(),
        onMessage: (msg) => service.intake(msg),
        icePolicy: config.directIcePolicy ?? 'stun',
        stunServers: config.stunServers,
        turnServers: config.turnServers,
        turnUsername: config.turnUsername,
        turnCredential: config.turnCredential,
    });
    const rendezvous = new RendezvousCoordinator(service, direct);
    service.setProtocolHandler((message) => rendezvous.handle(message));
    const removeDecisionListener = inbox.onDecision((message) => {
        if (message.deliveryId && message.channel === 'direct') {
            direct.acknowledge(message.deliveryId, message.status === 'accepted' ? 'accepted' : 'rejected');
        }
    });
    c.effect(() => {
        service.start();
        return () => {
            void service.stop();
            void direct.close();
            removeDecisionListener();
        };
    });
    const deps = {
        service,
        direct,
        inbox,
        contacts,
        rendezvous,
        identity,
        selfName: config.agentName,
        deviceName: config.deviceName || os.hostname(),
    };
    for (const def of buildToolDefs(deps))
        c.tools.register(defineTool(def));
    for (const def of buildCommandDefs(deps))
        c.commands.register(def);
}
export { QuarantineInbox } from './inbox.js';
export { MessengerService } from './service.js';
export { SseSubscription } from './sse.js';
export { TeamMcpClient, TeamMcpError, normalizeIncoming } from './teammcp-client.js';
export { GitHubTransport, GitHubTransportError } from './transports/github.js';
export { TeamMcpTransport } from './transports/teammcp.js';
export { DirectSessionManager } from './direct/session.js';
export { createDirectIdentity, fingerprintPublicKey, openDirectIdentity, } from './direct/identity.js';
export { decodeCode, encodeCode } from './direct/codec.js';
export { NoneTransport } from './transports/none.js';
export { CompositeTransport } from './transports/composite.js';
export { FilesystemTransport } from './transports/filesystem.js';
export { SecureTransport } from './transports/secure.js';
export { ContactStore, decodeContactCard, encodeContactCard } from './contacts.js';
export { MailboxEnvelopeCodec } from './mailbox-envelope.js';
export { RendezvousCoordinator } from './rendezvous.js';
export { buildCommandDefs, buildToolDefs, formatInjection, parseTarget, } from './surface.js';
