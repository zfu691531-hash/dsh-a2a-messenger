export class TeamMcpError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'TeamMcpError';
    }
}
function firstString(...values) {
    for (const v of values)
        if (typeof v === 'string' && v.length > 0)
            return v;
    return undefined;
}
/** djb2 hash, used only to synthesize a dedup id when the relay omits one. */
function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
        h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
}
/** Normalize one relay message object; returns undefined for unusable input. */
export function normalizeIncoming(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const r = raw;
    const content = firstString(r.content, r.text, r.body);
    if (content === undefined)
        return undefined;
    const from = firstString(r.from, r.sender, r.author) ?? 'unknown';
    const channel = firstString(r.channel, r.channel_id, r.channelId);
    const ts = typeof r.ts === 'number' ? r.ts : typeof r.timestamp === 'number' ? r.timestamp : Date.now();
    const id = firstString(r.id, r.message_id, r.messageId) ?? `${from}:${ts}:${hashText(content)}`;
    return { id, from, channel, content, ts };
}
export class TeamMcpClient {
    baseUrl;
    token;
    fetchImpl;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.token = options.token;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    authHeaders() {
        return { authorization: `Bearer ${this.token}` };
    }
    eventsUrl() {
        return `${this.baseUrl}/api/events`;
    }
    async request(method, path, body) {
        let res;
        try {
            res = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    ...this.authHeaders(),
                    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        }
        catch (err) {
            throw new TeamMcpError(`relay unreachable: ${err.message}`);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new TeamMcpError(`HTTP ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`, res.status);
        }
        if (res.status === 204)
            return undefined;
        return res.json().catch(() => undefined);
    }
    async health() {
        try {
            const res = await this.fetchImpl(`${this.baseUrl}/api/health`);
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async send(input) {
        if (!input.channel && !input.to)
            throw new TeamMcpError('send requires a channel or a dm target');
        const raw = (await this.request('POST', '/api/send', input));
        return {
            id: firstString(raw?.id, raw?.message_id),
            ts: typeof raw?.ts === 'number' ? raw.ts : undefined,
        };
    }
    async inbox() {
        const raw = await this.request('GET', '/api/inbox');
        const list = Array.isArray(raw)
            ? raw
            : Array.isArray(raw?.messages)
                ? raw.messages
                : [];
        const out = [];
        for (const item of list) {
            const msg = normalizeIncoming(item);
            if (msg)
                out.push(msg);
        }
        return out;
    }
    async ackInbox() {
        await this.request('POST', '/api/inbox/ack', {});
    }
    async agents() {
        const raw = await this.request('GET', '/api/agents');
        const list = Array.isArray(raw)
            ? raw
            : Array.isArray(raw?.agents)
                ? raw.agents
                : [];
        const out = [];
        for (const item of list) {
            if (typeof item === 'object' && item !== null) {
                const r = item;
                const name = firstString(r.name, r.agent_name);
                if (name) {
                    out.push({
                        name,
                        online: typeof r.online === 'boolean' ? r.online : undefined,
                        role: firstString(r.role),
                    });
                }
            }
            else if (typeof item === 'string') {
                out.push({ name: item });
            }
        }
        return out;
    }
    async channels() {
        const raw = await this.request('GET', '/api/channels');
        const list = Array.isArray(raw)
            ? raw
            : Array.isArray(raw?.channels)
                ? raw.channels
                : [];
        const out = [];
        for (const item of list) {
            if (typeof item === 'string')
                out.push(item);
            else if (typeof item === 'object' && item !== null) {
                const name = firstString(item.name);
                if (name)
                    out.push(name);
            }
        }
        return out;
    }
    /** Register a new agent identity on the relay. Requires no prior token. */
    static async register(baseUrl, input, fetchImpl = fetch) {
        const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new TeamMcpError(`registration failed: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
        }
        const raw = (await res.json());
        const apiKey = firstString(raw.apiKey, raw.api_key, raw.token);
        if (!apiKey)
            throw new TeamMcpError('registration response missing apiKey');
        return { apiKey, agent: raw.agent };
    }
}
