/** One parsed Server-Sent Event. */
export interface SseEvent {
  event: string
  data: string
}

export type SseState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'

export interface SseSubscriptionOptions {
  url: string
  headers?: Record<string, string>
  onEvent: (evt: SseEvent) => void
  onStateChange?: (state: SseState) => void
  fetchImpl?: typeof fetch
  /** First reconnect delay; doubles per failure. */
  minDelayMs?: number
  /** Reconnect delay cap. */
  maxDelayMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A long-lived SSE subscription with exponential-backoff reconnect.
 * `start()` returns immediately; events arrive on `onEvent` until `stop()`.
 */
export class SseSubscription {
  private stopped = false
  private controller: AbortController | undefined
  private loopPromise: Promise<void> | undefined
  private currentState: SseState = 'idle'

  constructor(private readonly opts: SseSubscriptionOptions) {}

  get state(): SseState {
    return this.currentState
  }

  start(): void {
    if (this.loopPromise) return
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.controller?.abort()
    this.setState('stopped')
    await this.loopPromise?.catch(() => {})
  }

  private setState(state: SseState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.opts.onStateChange?.(state)
  }

  private async loop(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const minDelay = this.opts.minDelayMs ?? 1_000
    const maxDelay = this.opts.maxDelayMs ?? 60_000
    let delay = minDelay
    while (!this.stopped) {
      this.controller = new AbortController()
      try {
        this.setState(this.currentState === 'idle' ? 'connecting' : 'reconnecting')
        const res = await fetchImpl(this.opts.url, {
          headers: { accept: 'text/event-stream', ...this.opts.headers },
          signal: this.controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        this.setState('connected')
        delay = minDelay
        await this.readStream(res.body)
      } catch {
        // Fall through to the retry delay below.
      }
      if (this.stopped) break
      this.setState('reconnecting')
      await sleep(delay)
      delay = Math.min(delay * 2, maxDelay)
    }
    this.setState('stopped')
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    const reader = body.getReader()
    let buffer = ''
    let eventName = 'message'
    let dataLines: string[] = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '')
          buffer = buffer.slice(idx + 1)
          if (line === '') {
            if (dataLines.length > 0) {
              const evt: SseEvent = { event: eventName, data: dataLines.join('\n') }
              eventName = 'message'
              dataLines = []
              this.opts.onEvent(evt)
            } else {
              eventName = 'message'
            }
          } else if (line.startsWith(':')) {
            // Comment / keep-alive.
          } else if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
