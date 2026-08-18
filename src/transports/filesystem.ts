import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from '../types.js'
import type {
  Transport,
  TransportHandlers,
  TransportSendInput,
  TransportState,
} from '../transport.js'

export interface FilesystemTransportOptions {
  directory: string
  selfName: string
  pollIntervalMs?: number
  backfillMs?: number
}

interface StoredMessage extends IncomingMessage {
  to?: string
}

/** Shared-folder mailbox for Syncthing, OneDrive, NAS, or removable media. */
export class FilesystemTransport implements Transport {
  readonly kind = 'filesystem'
  private currentState: TransportState = 'idle'
  private handlers: TransportHandlers | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly seen = new Set<string>()
  private readonly messagesDir: string
  private readonly pollIntervalMs: number
  private readonly cutoff: number
  private stopped = false

  constructor(private readonly opts: FilesystemTransportOptions) {
    if (!opts.directory.trim()) throw new Error('filesystem transport needs a shared directory')
    this.messagesDir = join(opts.directory, 'messages')
    this.pollIntervalMs = Math.max(1_000, opts.pollIntervalMs ?? 5_000)
    this.cutoff = Date.now() - (opts.backfillMs ?? 24 * 60 * 60 * 1000)
  }

  get state(): TransportState {
    return this.currentState
  }

  start(handlers: TransportHandlers): void {
    if (this.handlers) return
    this.handlers = handlers
    this.stopped = false
    mkdirSync(this.messagesDir, { recursive: true })
    this.setState('connecting')
    void this.tick()
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.stopped = true
    this.handlers = undefined
    this.setState('stopped')
  }

  async send(input: TransportSendInput): Promise<{ id?: string }> {
    if (!input.channel && !input.to) throw new Error('filesystem send requires a channel or recipient')
    mkdirSync(this.messagesDir, { recursive: true })
    const id = `fs-${randomUUID()}`
    const message: StoredMessage = {
      id,
      from: this.opts.selfName,
      channel: input.channel,
      to: input.to,
      content: input.content,
      ts: Date.now(),
    }
    const finalPath = join(this.messagesDir, `${message.ts}-${id}.json`)
    const tmpPath = `${finalPath}.${process.pid}.tmp`
    writeFileSync(tmpPath, JSON.stringify(message), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, finalPath)
    this.seen.add(id)
    return { id }
  }

  async pollOnce(): Promise<number> {
    mkdirSync(this.messagesDir, { recursive: true })
    let delivered = 0
    const files = readdirSync(this.messagesDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
    for (const file of files) {
      let message: StoredMessage | undefined
      try {
        message = parseStored(JSON.parse(readFileSync(join(this.messagesDir, file), 'utf8')))
      } catch {
        continue
      }
      if (!message || this.seen.has(message.id)) continue
      this.seen.add(message.id)
      if (message.ts < this.cutoff || message.from === this.opts.selfName) continue
      if (message.to && message.to !== this.opts.selfName) continue
      this.handlers?.onMessage(message)
      delivered++
    }
    return delivered
  }

  async channels(): Promise<string[]> {
    return []
  }

  diagnostics(): Record<string, unknown> {
    return { directory: this.opts.directory, polling: true, relay: false }
  }

  private async tick(): Promise<void> {
    try {
      await this.pollOnce()
      if (this.stopped) return
      this.setState('connected')
    } catch (err) {
      this.setState('reconnecting')
      this.handlers?.onError?.(err)
    }
    if (this.stopped || !this.handlers) return
    this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs)
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.handlers?.onStateChange?.(state)
  }
}

function parseStored(value: unknown): StoredMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Partial<StoredMessage>
  if (
    typeof raw.id !== 'string' || raw.id.length > 160 ||
    typeof raw.from !== 'string' || raw.from.length > 128 ||
    typeof raw.content !== 'string' || Buffer.byteLength(raw.content, 'utf8') > 512 * 1024 ||
    typeof raw.ts !== 'number' || !Number.isFinite(raw.ts) ||
    (raw.channel !== undefined && typeof raw.channel !== 'string') ||
    (raw.to !== undefined && typeof raw.to !== 'string')
  ) return undefined
  return raw as StoredMessage
}
