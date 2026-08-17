import type { IncomingMessage } from './types.js'

/**
 * Minimal HTTP client for a TeamMCP relay (https://github.com/cookjohn/teammcp).
 * Only the endpoints this plugin needs are covered. Response shapes are
 * normalized defensively because TeamMCP documents endpoints, not schemas;
 * the mapping is verified against test/mock-teammcp-server.mjs and must be
 * re-checked against a real server during two-device validation.
 */

export interface TeamMcpClientOptions {
  /** Relay base URL, e.g. `https://relay.example.com`. */
  baseUrl: string
  /** Bearer token issued by `POST /api/register` (`tmcp_...`). */
  token: string
  fetchImpl?: typeof fetch
}

export class TeamMcpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'TeamMcpError'
  }
}

export interface SendInput {
  /** Target channel name. Mutually exclusive with `to`. */
  channel?: string
  /** Target agent name for a direct message. Mutually exclusive with `channel`. */
  to?: string
  content: string
}

export interface SendReceipt {
  id?: string
  ts?: number
}

export interface PeerInfo {
  name: string
  online?: boolean
  role?: string
}

export interface RegisterInput {
  name: string
  role?: string
  secret?: string
}

export interface RegisterResult {
  apiKey: string
  agent?: { name?: string; role?: string }
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

/** djb2 hash, used only to synthesize a dedup id when the relay omits one. */
function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/** Normalize one relay message object; returns undefined for unusable input. */
export function normalizeIncoming(raw: unknown): IncomingMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const content = firstString(r.content, r.text, r.body)
  if (content === undefined) return undefined
  const from = firstString(r.from, r.sender, r.author) ?? 'unknown'
  const channel = firstString(r.channel, r.channel_id, r.channelId)
  const ts =
    typeof r.ts === 'number' ? r.ts : typeof r.timestamp === 'number' ? r.timestamp : Date.now()
  const id = firstString(r.id, r.message_id, r.messageId) ?? `${from}:${ts}:${hashText(content)}`
  return { id, from, channel, content, ts }
}

export class TeamMcpClient {
  private readonly baseUrl: string
  private readonly token: string
  readonly fetchImpl: typeof fetch

  constructor(options: TeamMcpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` }
  }

  eventsUrl(): string {
    return `${this.baseUrl}/api/events`
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...this.authHeaders(),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new TeamMcpError(`relay unreachable: ${(err as Error).message}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new TeamMcpError(`HTTP ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`, res.status)
    }
    if (res.status === 204) return undefined
    return res.json().catch(() => undefined)
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/health`)
      return res.ok
    } catch {
      return false
    }
  }

  async send(input: SendInput): Promise<SendReceipt> {
    if (!input.channel && !input.to) throw new TeamMcpError('send requires a channel or a dm target')
    const raw = (await this.request('POST', '/api/send', input)) as Record<string, unknown> | undefined
    return {
      id: firstString(raw?.id, raw?.message_id),
      ts: typeof raw?.ts === 'number' ? raw.ts : undefined,
    }
  }

  async inbox(): Promise<IncomingMessage[]> {
    const raw = await this.request('GET', '/api/inbox')
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as Record<string, unknown> | undefined)?.messages)
        ? ((raw as Record<string, unknown>).messages as unknown[])
        : []
    const out: IncomingMessage[] = []
    for (const item of list) {
      const msg = normalizeIncoming(item)
      if (msg) out.push(msg)
    }
    return out
  }

  async ackInbox(): Promise<void> {
    await this.request('POST', '/api/inbox/ack', {})
  }

  async agents(): Promise<PeerInfo[]> {
    const raw = await this.request('GET', '/api/agents')
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as Record<string, unknown> | undefined)?.agents)
        ? ((raw as Record<string, unknown>).agents as unknown[])
        : []
    const out: PeerInfo[] = []
    for (const item of list) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>
        const name = firstString(r.name, r.agent_name)
        if (name) {
          out.push({
            name,
            online: typeof r.online === 'boolean' ? r.online : undefined,
            role: firstString(r.role),
          })
        }
      } else if (typeof item === 'string') {
        out.push({ name: item })
      }
    }
    return out
  }

  async channels(): Promise<string[]> {
    const raw = await this.request('GET', '/api/channels')
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as Record<string, unknown> | undefined)?.channels)
        ? ((raw as Record<string, unknown>).channels as unknown[])
        : []
    const out: string[] = []
    for (const item of list) {
      if (typeof item === 'string') out.push(item)
      else if (typeof item === 'object' && item !== null) {
        const name = firstString((item as Record<string, unknown>).name)
        if (name) out.push(name)
      }
    }
    return out
  }

  /** Register a new agent identity on the relay. Requires no prior token. */
  static async register(
    baseUrl: string,
    input: RegisterInput,
    fetchImpl: typeof fetch = fetch,
  ): Promise<RegisterResult> {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new TeamMcpError(`registration failed: HTTP ${res.status} ${text.slice(0, 200)}`, res.status)
    }
    const raw = (await res.json()) as Record<string, unknown>
    const apiKey = firstString(raw.apiKey, raw.api_key, raw.token)
    if (!apiKey) throw new TeamMcpError('registration response missing apiKey')
    return { apiKey, agent: raw.agent as RegisterResult['agent'] }
  }
}
