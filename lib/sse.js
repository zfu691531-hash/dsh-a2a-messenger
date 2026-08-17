function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * A long-lived SSE subscription with exponential-backoff reconnect.
 * `start()` returns immediately; events arrive on `onEvent` until `stop()`.
 */
export class SseSubscription {
    opts;
    stopped = false;
    controller;
    loopPromise;
    currentState = 'idle';
    constructor(opts) {
        this.opts = opts;
    }
    get state() {
        return this.currentState;
    }
    start() {
        if (this.loopPromise)
            return;
        this.loopPromise = this.loop();
    }
    async stop() {
        this.stopped = true;
        this.controller?.abort();
        this.setState('stopped');
        await this.loopPromise?.catch(() => { });
    }
    setState(state) {
        if (this.currentState === state)
            return;
        this.currentState = state;
        this.opts.onStateChange?.(state);
    }
    async loop() {
        const fetchImpl = this.opts.fetchImpl ?? fetch;
        const minDelay = this.opts.minDelayMs ?? 1_000;
        const maxDelay = this.opts.maxDelayMs ?? 60_000;
        let delay = minDelay;
        while (!this.stopped) {
            this.controller = new AbortController();
            try {
                this.setState(this.currentState === 'idle' ? 'connecting' : 'reconnecting');
                const res = await fetchImpl(this.opts.url, {
                    headers: { accept: 'text/event-stream', ...this.opts.headers },
                    signal: this.controller.signal,
                });
                if (!res.ok || !res.body)
                    throw new Error(`SSE HTTP ${res.status}`);
                this.setState('connected');
                delay = minDelay;
                await this.readStream(res.body);
            }
            catch {
                // Fall through to the retry delay below.
            }
            if (this.stopped)
                break;
            this.setState('reconnecting');
            await sleep(delay);
            delay = Math.min(delay * 2, maxDelay);
        }
        this.setState('stopped');
    }
    async readStream(body) {
        const decoder = new TextDecoder();
        const reader = body.getReader();
        let buffer = '';
        let eventName = 'message';
        let dataLines = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, idx).replace(/\r$/, '');
                    buffer = buffer.slice(idx + 1);
                    if (line === '') {
                        if (dataLines.length > 0) {
                            const evt = { event: eventName, data: dataLines.join('\n') };
                            eventName = 'message';
                            dataLines = [];
                            this.opts.onEvent(evt);
                        }
                        else {
                            eventName = 'message';
                        }
                    }
                    else if (line.startsWith(':')) {
                        // Comment / keep-alive.
                    }
                    else if (line.startsWith('event:')) {
                        eventName = line.slice('event:'.length).trim();
                    }
                    else if (line.startsWith('data:')) {
                        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
}
