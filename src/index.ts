import { execSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DirectSessionManager } from './direct/session.js'
import { openDirectIdentity } from './direct/identity.js'
import { QuarantineInbox } from './inbox.js'
import { MessengerService } from './service.js'
import { buildCommandDefs, buildToolDefs, PLUGIN_NAME } from './surface.js'
import { TeamMcpClient } from './teammcp-client.js'
import type { Transport } from './transport.js'
import { GitHubTransport } from './transports/github.js'
import { NoneTransport } from './transports/none.js'
import { TeamMcpTransport } from './transports/teammcp.js'

export const name = PLUGIN_NAME
export const inject = ['tools', 'commands']

export interface Config {
  agentName: string
  transport: 'none' | 'github' | 'teammcp'
  dataDir: string
  trustedPeers: string[]
  githubRepo: string
  githubToken: string
  githubChannels: string[]
  githubPollSeconds: number
  serverUrl: string
  token: string
}

export const Config: Schema<Config> = Schema.object({
  agentName: Schema.string()
    .required()
    .description('Your display name shown to teammates'),
  transport: Schema.union(['none', 'github', 'teammcp'] as const)
    .default('github')
    .description('Async mailbox transport: "none" (direct-only), "github", or "teammcp"'),
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
  serverUrl: Schema.string()
    .default('')
    .description('teammcp transport: relay base URL, e.g. https://relay.example.com'),
  token: Schema.string()
    .default('')
    .role('secret')
    .description('teammcp transport: relay API key from POST /api/register (tmcp_...)'),
})

/** Structural view of the DSH seams this plugin uses. */
interface MessengerCtx {
  effect(callback: () => void | (() => void)): unknown
  tools: { register(tool: unknown): unknown }
  commands: { register(definition: unknown): unknown }
}

function resolveGitHubToken(configured: string): string {
  if (configured) return configured
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (env) return env
  try {
    const fromCli = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (fromCli) return fromCli
  } catch {
    // gh CLI absent or not logged in.
  }
  throw new Error(
    `[${PLUGIN_NAME}] github transport needs a token: set githubToken in the plugin config, ` +
      'or export GITHUB_TOKEN, or log in with `gh auth login`',
  )
}

export function parseTrustedPeers(entries: readonly string[]): ReadonlyMap<string, string> {
  const peers = new Map<string, string>()
  const fingerprintsByName = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    const name = separator > 0 ? entry.slice(0, separator).trim() : ''
    const fingerprint = separator > 0 ? entry.slice(separator + 1).trim() : ''
    if (!name || !/^ed25519:[A-Za-z0-9_-]{43}$/.test(fingerprint)) {
      throw new Error(
        `[${PLUGIN_NAME}] invalid trustedPeers entry "${entry}"; expected "name=ed25519:fingerprint"`,
      )
    }
    const existingName = peers.get(fingerprint)
    if (existingName && existingName !== name) {
      throw new Error(`[${PLUGIN_NAME}] fingerprint ${fingerprint} is assigned to multiple names`)
    }
    const existingFingerprint = fingerprintsByName.get(name)
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new Error(`[${PLUGIN_NAME}] peer name "${name}" is assigned to multiple fingerprints`)
    }
    peers.set(fingerprint, name)
    fingerprintsByName.set(name, fingerprint)
  }
  return peers
}

export function buildTransport(config: Config, dataDir: string): Transport {
  if (config.transport === 'none') return new NoneTransport()
  if (config.transport === 'teammcp') {
    if (!config.serverUrl || !config.token) {
      throw new Error(`[${PLUGIN_NAME}] teammcp transport needs serverUrl and token in the plugin config`)
    }
    return new TeamMcpTransport({
      client: new TeamMcpClient({ baseUrl: config.serverUrl, token: config.token }),
      selfName: config.agentName,
    })
  }
  if (!config.githubRepo) {
    throw new Error(`[${PLUGIN_NAME}] github transport needs githubRepo ("owner/name") in the plugin config`)
  }
  return new GitHubTransport({
    repo: config.githubRepo,
    token: resolveGitHubToken(config.githubToken),
    channels: config.githubChannels.length > 0 ? config.githubChannels : ['general'],
    pollIntervalMs: config.githubPollSeconds * 1000,
    cursorFile: path.join(dataDir, 'github-cursor.json'),
  })
}

export function apply(ctx: Context, config: Config): void {
  const c = ctx as unknown as MessengerCtx

  const dataDir = config.dataDir || path.join(os.homedir(), '.dsh-a2a-messenger')
  const inbox = QuarantineInbox.open(path.join(dataDir, 'inbox.json'))
  const identity = openDirectIdentity(path.join(dataDir, 'direct-identity.json'))
  const transport = buildTransport(config, dataDir)
  const service = new MessengerService({
    transport,
    inbox,
    selfName: config.agentName,
    onError: (err) => console.warn(`[${PLUGIN_NAME}]`, err),
  })
  const direct = new DirectSessionManager({
    selfName: config.agentName,
    identity,
    trustedPeers: parseTrustedPeers(config.trustedPeers ?? []),
    onMessage: (msg) => service.intake(msg),
  })

  c.effect(() => {
    service.start()
    return () => {
      void service.stop()
      void direct.close()
    }
  })

  const deps = { service, direct, inbox, selfName: config.agentName }
  for (const def of buildToolDefs(deps)) c.tools.register(defineTool(def as never))
  for (const def of buildCommandDefs(deps)) c.commands.register(def)
}

export { QuarantineInbox } from './inbox.js'
export { MessengerService } from './service.js'
export { SseSubscription } from './sse.js'
export { TeamMcpClient, TeamMcpError, normalizeIncoming } from './teammcp-client.js'
export { GitHubTransport, GitHubTransportError } from './transports/github.js'
export { TeamMcpTransport } from './transports/teammcp.js'
export { DirectSessionManager } from './direct/session.js'
export {
  createDirectIdentity,
  fingerprintPublicKey,
  openDirectIdentity,
} from './direct/identity.js'
export { decodeCode, encodeCode } from './direct/codec.js'
export { NoneTransport } from './transports/none.js'
export {
  buildCommandDefs,
  buildToolDefs,
  formatInjection,
  parseTarget,
} from './surface.js'
export type { Transport, TransportState, TransportSendInput } from './transport.js'
export type { IncomingMessage, QuarantinedMessage, QuarantineStatus } from './types.js'
