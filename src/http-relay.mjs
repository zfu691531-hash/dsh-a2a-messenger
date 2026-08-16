import { createServer } from 'node:http';
import { URL } from 'node:url';
import { MAX_FRAME_BYTES } from './protocol.mjs';
import { sha256 } from './crypto.mjs';
import { LoopbackRelayTransport } from './relay.mjs';

const MAX_BODY_BYTES = MAX_FRAME_BYTES + 65_536;
const MAX_HTTP_PULL_MESSAGES = 16;
const relayToken = /^[A-Za-z0-9_-]{43}$/;
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeRelayErrors = new Map([
  ['expired', 410],
  ['relay_mailbox_quota', 429],
  ['relay_sender_mailbox_quota', 429],
  ['relay_global_quota', 429],
  ['relay_recipient_not_registered', 403],
  ['relay_frame_too_large', 413],
  ['relay_fanout_exceeded', 400],
  ['invalid_pull_limit', 400],
]);

function relayError(status, code) {
  const error = new Error(code);
  error.status = status;
  return error;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw relayError(413, 'relay_body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw relayError(400, 'relay_invalid_json'); }
}

export class HttpRelayServer {
  constructor({ path = ':memory:', host = '127.0.0.1', port = 0, allowInsecureNetwork = false } = {}) {
    if (!loopbackHosts.has(host) && !allowInsecureNetwork) throw new Error('relay_non_loopback_requires_explicit_insecure_opt_in');
    this.host = host;
    this.port = port;
    this.relay = new LoopbackRelayTransport(path);
    this.relay.db.exec(`CREATE TABLE IF NOT EXISTS relay_credentials (
      device_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`);
    this.server = createServer((request, response) => this.#handle(request, response));
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
  }

  registerCredential(deviceId, token) {
    if (typeof deviceId !== 'string' || !uuid.test(deviceId)) throw new Error('invalid_device_id');
    if (typeof token !== 'string' || !relayToken.test(token)) throw new Error('relay_token_invalid');
    this.relay.db.prepare(`INSERT INTO relay_credentials(device_id,token_hash,created_at,revoked_at)
      VALUES(?,?,?,NULL) ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,revoked_at=NULL`)
      .run(deviceId, sha256(token), new Date().toISOString());
  }

  revokeCredential(deviceId) {
    this.relay.db.prepare('UPDATE relay_credentials SET revoked_at=? WHERE device_id=?').run(new Date().toISOString(), deviceId);
  }

  credentialRows() {
    return this.relay.db.prepare('SELECT device_id,token_hash,created_at,revoked_at FROM relay_credentials').all();
  }

  #authenticate(request) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    if (!match) throw relayError(401, 'relay_auth_required');
    const row = this.relay.db.prepare('SELECT device_id FROM relay_credentials WHERE token_hash=? AND revoked_at IS NULL').get(sha256(match[1]));
    if (!row) throw relayError(403, 'relay_auth_failed');
    return row.device_id;
  }

  async #handle(request, response) {
    try {
      const url = new URL(request.url, 'http://relay.invalid');
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, { ok: true, kind: 'http-sqlite', plaintextContent: false });
        return;
      }
      const deviceId = this.#authenticate(request);
      if (request.method === 'POST' && url.pathname === '/v1/frames') {
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw relayError(415, 'relay_content_type_required');
        const frame = await readJson(request);
        if (frame.senderDeviceId !== deviceId) throw relayError(403, 'relay_sender_device_mismatch');
        for (const recipientDeviceId of frame.recipientDeviceIds ?? []) {
          const recipient = this.relay.db.prepare('SELECT 1 FROM relay_credentials WHERE device_id=? AND revoked_at IS NULL').get(recipientDeviceId);
          if (!recipient) throw relayError(403, 'relay_recipient_not_registered');
        }
        const accepted = this.relay.publish(frame);
        sendJson(response, 202, accepted);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/mailbox') {
        const cursor = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? MAX_HTTP_PULL_MESSAGES);
        if (!Number.isInteger(cursor) || cursor < 0) throw relayError(400, 'relay_cursor_invalid');
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HTTP_PULL_MESSAGES) throw relayError(400, 'invalid_pull_limit');
        sendJson(response, 200, { deliveries: this.relay.pull(deviceId, cursor, limit) });
        return;
      }
      throw relayError(404, 'relay_not_found');
    } catch (error) {
      const known = Number.isInteger(error.status);
      const safeStatus = safeRelayErrors.get(error.message);
      const status = known ? error.status : safeStatus ?? 400;
      sendJson(response, status, { ok: false, error: known || safeStatus ? error.message : 'relay_request_rejected' });
    }
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    const host = address.address.includes(':') ? `[${address.address}]` : address.address;
    return { host: address.address, port: address.port, url: `http://${host}:${address.port}` };
  }

  async close() {
    if (this.server.listening) await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.relay.close();
  }
}

export class HttpRelayTransport {
  constructor({ baseUrl, deviceId, token, allowInsecureNetwork = false, timeoutMs = 10_000 }) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('relay_url_invalid');
    if (parsed.protocol === 'http:' && !loopbackHosts.has(parsed.hostname) && !allowInsecureNetwork) throw new Error('relay_plain_http_non_loopback_denied');
    if (typeof token !== 'string' || !relayToken.test(token)) throw new Error('relay_token_invalid');
    this.baseUrl = parsed.href.replace(/\/$/, '');
    this.deviceId = deviceId;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async #request(path, options = {}) {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { authorization: `Bearer ${this.token}`, ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const value = await response.json().catch(() => ({ error: 'relay_invalid_response' }));
      if (!response.ok) throw relayError(response.status, value.error ?? 'relay_request_rejected');
      return value;
    } catch (error) {
      if (Number.isInteger(error.status)) throw error;
      throw new Error('relay_offline');
    }
  }

  health() {
    return fetch(`${this.baseUrl}/v1/health`, { signal: AbortSignal.timeout(this.timeoutMs) }).then((response) => response.json());
  }

  publish(frame) {
    if (frame.senderDeviceId !== this.deviceId) throw new Error('relay_sender_device_mismatch');
    return this.#request('/v1/frames', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame),
    });
  }

  async pull(mailbox, cursor = 0, limit = MAX_HTTP_PULL_MESSAGES) {
    if (mailbox !== this.deviceId) throw new Error('relay_mailbox_mismatch');
    if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid_pull_limit');
    const boundedLimit = Math.min(limit, MAX_HTTP_PULL_MESSAGES);
    const value = await this.#request(`/v1/mailbox?cursor=${encodeURIComponent(cursor)}&limit=${boundedLimit}`);
    return value.deliveries;
  }
}
