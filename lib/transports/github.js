import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export class GitHubTransportError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'GitHubTransportError';
    }
}
const CHANNEL_LABEL = 'a2a-channel';
/**
 * Zero-deployment mailbox transport on top of a private GitHub repository.
 * Each channel is one issue (`a2a: <name>`, labelled `a2a-channel`) and each
 * message is one issue comment, so identity, access control (collaborators),
 * offline storage, and a human-readable web UI all come from GitHub itself.
 * Delivery is polling-based: expect seconds of latency, not real time.
 */
export class GitHubTransport {
    opts;
    kind = 'github';
    currentState = 'idle';
    handlers;
    timer;
    stopped = false;
    selfLogin = '';
    issueByChannel = new Map();
    cursor = '';
    pollIntervalMs;
    fetchImpl;
    apiBase;
    constructor(opts) {
        this.opts = opts;
        this.pollIntervalMs = Math.max(5_000, opts.pollIntervalMs ?? 30_000);
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    }
    get state() {
        return this.currentState;
    }
    get login() {
        return this.selfLogin;
    }
    start(handlers) {
        if (this.handlers)
            return;
        this.handlers = handlers;
        this.stopped = false;
        void this.run();
    }
    async stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.setState('stopped');
    }
    async send(input) {
        if (input.to) {
            throw new GitHubTransportError('direct messages are not supported on the github transport; post to a channel, or use a direct session (/a2a-connect)');
        }
        const channel = input.channel;
        if (!channel)
            throw new GitHubTransportError('send requires a channel');
        const issue = await this.ensureChannelIssue(channel);
        const raw = (await this.request('POST', `/repos/${this.opts.repo}/issues/${issue}/comments`, {
            body: input.content,
        }));
        return { id: raw.id !== undefined ? `gh-${raw.id}` : undefined };
    }
    async peers() {
        const raw = await this.request('GET', `/repos/${this.opts.repo}/collaborators?per_page=100`);
        if (!Array.isArray(raw))
            return [];
        return raw
            .map((item) => item.login)
            .filter((login) => typeof login === 'string')
            .map((login) => ({ name: login, online: undefined }));
    }
    async channels() {
        return [...this.opts.channels];
    }
    setState(state) {
        if (this.currentState === state)
            return;
        this.currentState = state;
        this.handlers?.onStateChange?.(state);
    }
    async run() {
        this.setState('connecting');
        try {
            await this.init();
            this.setState('connected');
        }
        catch (err) {
            this.handlers?.onError?.(err);
            this.setState('failed');
            if (!this.stopped)
                this.timer = setTimeout(() => void this.run(), this.pollIntervalMs);
            return;
        }
        await this.pollLoop();
    }
    async init() {
        const user = (await this.request('GET', '/user'));
        this.selfLogin = typeof user.login === 'string' ? user.login : '';
        for (const channel of this.opts.channels)
            await this.ensureChannelIssue(channel);
        this.cursor = this.loadCursor();
    }
    async pollLoop() {
        while (!this.stopped) {
            try {
                await this.pollOnce();
                this.setState('connected');
            }
            catch (err) {
                this.handlers?.onError?.(err);
                this.setState('reconnecting');
            }
            if (this.stopped)
                break;
            await new Promise((resolve) => {
                this.timer = setTimeout(resolve, this.pollIntervalMs);
            });
        }
    }
    /** One poll pass over every watched channel. Exposed for tests. */
    async pollOnce() {
        let delivered = 0;
        let maxSeen = this.cursor;
        for (const [channel, issue] of this.issueByChannel) {
            const since = encodeURIComponent(this.cursor);
            const raw = await this.request('GET', `/repos/${this.opts.repo}/issues/${issue}/comments?since=${since}&per_page=100`);
            if (!Array.isArray(raw))
                continue;
            for (const item of raw) {
                const msg = this.normalizeComment(item, channel);
                if (!msg)
                    continue;
                const createdAt = new Date(msg.ts).toISOString();
                if (createdAt > maxSeen)
                    maxSeen = createdAt;
                if (msg.from === this.selfLogin)
                    continue;
                this.handlers?.onMessage(msg);
                delivered++;
            }
        }
        if (maxSeen !== this.cursor) {
            this.cursor = maxSeen;
            this.saveCursor();
        }
        return delivered;
    }
    normalizeComment(raw, channel) {
        if (typeof raw !== 'object' || raw === null)
            return undefined;
        const r = raw;
        const body = typeof r.body === 'string' ? r.body : undefined;
        if (!body)
            return undefined;
        const id = r.id !== undefined ? `gh-${r.id}` : undefined;
        if (!id)
            return undefined;
        const user = (r.user ?? {});
        const from = typeof user.login === 'string' ? user.login : 'unknown';
        const ts = typeof r.created_at === 'string' ? Date.parse(r.created_at) || Date.now() : Date.now();
        return { id, from, channel, content: body, ts };
    }
    async ensureChannelIssue(channel) {
        const cached = this.issueByChannel.get(channel);
        if (cached !== undefined)
            return cached;
        const title = `a2a: ${channel}`;
        const list = await this.request('GET', `/repos/${this.opts.repo}/issues?state=open&labels=${CHANNEL_LABEL}&per_page=100`);
        if (Array.isArray(list)) {
            for (const item of list) {
                const r = item;
                if (r.title === title && typeof r.number === 'number') {
                    this.issueByChannel.set(channel, r.number);
                    return r.number;
                }
            }
        }
        const created = (await this.request('POST', `/repos/${this.opts.repo}/issues`, {
            title,
            labels: [CHANNEL_LABEL],
            body: `Channel \`${channel}\` for dsh-a2a-messenger. Comments on this issue are the channel's messages; you can also read and post from this page directly.`,
        }));
        if (typeof created.number !== 'number') {
            throw new GitHubTransportError('failed to create channel issue');
        }
        this.issueByChannel.set(channel, created.number);
        return created.number;
    }
    async request(method, path, body) {
        let res;
        try {
            res = await this.fetchImpl(`${this.apiBase}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${this.opts.token}`,
                    accept: 'application/vnd.github+json',
                    'user-agent': 'dsh-a2a-messenger',
                    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        }
        catch (err) {
            throw new GitHubTransportError(`github unreachable: ${err.message}`);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new GitHubTransportError(`HTTP ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`, res.status);
        }
        return res.json().catch(() => undefined);
    }
    loadCursor() {
        const file = this.opts.cursorFile;
        if (file && existsSync(file)) {
            try {
                const raw = JSON.parse(readFileSync(file, 'utf8'));
                if (typeof raw.cursor === 'string' && raw.cursor.length > 0)
                    return raw.cursor;
            }
            catch {
                // Corrupted cursor: fall through to backfill window.
            }
        }
        const backfill = this.opts.backfillMs ?? 3_600_000;
        return new Date(Date.now() - backfill).toISOString();
    }
    saveCursor() {
        const file = this.opts.cursorFile;
        if (!file)
            return;
        try {
            mkdirSync(dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            writeFileSync(tmp, JSON.stringify({ cursor: this.cursor }), 'utf8');
            renameSync(tmp, file);
        }
        catch {
            // Cursor persistence is best-effort; inbox dedup covers replays.
        }
    }
}
