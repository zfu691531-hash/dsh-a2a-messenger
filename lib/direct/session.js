import { randomUUID } from 'node:crypto';
import { decodeCode, encodeCode, isLegacyCode, verifyPayload } from './codec.js';
const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_WIRE_BYTES = MAX_MESSAGE_BYTES + 1024;
const MAX_MESSAGE_ID_CHARS = 128;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
async function loadRtc(injected) {
    if (injected)
        return injected;
    try {
        const mod = (await import('@roamhq/wrtc'));
        const resolved = 'RTCPeerConnection' in mod ? mod : mod.default;
        if (resolved && 'RTCPeerConnection' in resolved)
            return resolved;
        throw new Error('module loaded but RTCPeerConnection missing');
    }
    catch (err) {
        throw new Error(`WebRTC engine unavailable (${err.message}). ` +
            'Install the optional dependency with: npm install @roamhq/wrtc');
    }
}
export class DirectSessionManager {
    opts;
    currentState = 'idle';
    pc;
    dc;
    remoteName = '';
    remoteFingerprint = '';
    pendingSessionId = '';
    deliveryReceipts = new Map();
    lastCandidateTypes = [];
    lastProtocols = [];
    constructor(opts) {
        this.opts = opts;
        if ((opts.icePolicy ?? 'stun') === 'relay' && (opts.turnServers?.length ?? 0) === 0) {
            throw new Error('relay ICE policy requires at least one TURN server');
        }
    }
    get state() {
        return this.currentState;
    }
    get peerName() {
        return this.remoteName;
    }
    get peerFingerprint() {
        return this.remoteFingerprint;
    }
    get localFingerprint() {
        return this.opts.identity.fingerprint;
    }
    get diagnostics() {
        const policy = this.opts.icePolicy ?? 'stun';
        const stunServers = policy === 'stun' ? [...(this.opts.stunServers ?? DEFAULT_STUN)] : [];
        const turnServers = policy === 'relay' ? [...(this.opts.turnServers ?? [])] : [];
        return {
            policy,
            stunServers,
            turnServers,
            candidateTypes: [...this.lastCandidateTypes],
            protocols: [...this.lastProtocols],
            serverContact: policy === 'strict' || (policy === 'stun' && stunServers.length === 0)
                ? 'none'
                : policy === 'relay' ? 'turn' : 'stun',
        };
    }
    receipts() {
        const now = Date.now();
        for (const receipt of this.deliveryReceipts.values()) {
            if (receipt.status === 'sent' && now - receipt.updatedAt > RECEIPT_TTL_MS)
                receipt.status = 'expired';
        }
        return [...this.deliveryReceipts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    /** Start a session: returns the offer connect-code to hand to the peer. */
    async createOffer() {
        if (this.pc)
            await this.close();
        const rtc = await loadRtc(this.opts.rtcModule);
        this.pc = new rtc.RTCPeerConnection(this.iceConfig());
        this.watchConnection(this.pc);
        this.attachChannel(this.pc.createDataChannel('a2a'));
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        await this.waitIceGathering(this.pc);
        const sdp = this.pc.localDescription?.sdp;
        if (!sdp)
            throw new Error('no local description after ICE gathering');
        this.pendingSessionId = randomUUID();
        this.captureCandidates(sdp);
        this.setState('waiting-answer');
        return encodeCode({
            v: 2,
            role: 'offer',
            name: this.opts.selfName,
            sdp,
            sessionId: this.pendingSessionId,
            publicKey: this.opts.identity.publicKey,
        }, this.opts.identity);
    }
    /**
     * Paste a connect code from the peer.
     * - Offer code: joins the session; returns the answer code to send back.
     * - Answer code: completes a session started with {@link createOffer}.
     */
    async accept(code) {
        const payload = decodeCode(code);
        if (!payload) {
            if (isLegacyCode(code)) {
                throw new Error('legacy unsigned A2A1 connect codes are not accepted; upgrade both peers');
            }
            throw new Error('invalid or unsupported connect code');
        }
        const peer = this.verifyPeer(payload);
        if (payload.role === 'offer') {
            if (this.pc)
                await this.close();
            const rtc = await loadRtc(this.opts.rtcModule);
            this.remoteName = peer.name;
            this.remoteFingerprint = peer.fingerprint;
            this.pc = new rtc.RTCPeerConnection(this.iceConfig());
            this.watchConnection(this.pc);
            this.pc.ondatachannel = (evt) => this.attachChannel(evt.channel);
            await this.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            await this.waitIceGathering(this.pc);
            const sdp = this.pc.localDescription?.sdp;
            if (!sdp)
                throw new Error('no local description after ICE gathering');
            this.setState('connecting');
            this.captureCandidates(sdp);
            return {
                answerCode: encodeCode({
                    v: 2,
                    role: 'answer',
                    name: this.opts.selfName,
                    sdp,
                    sessionId: payload.sessionId,
                    publicKey: this.opts.identity.publicKey,
                }, this.opts.identity),
            };
        }
        // Answer code path.
        if (!this.pc || this.currentState !== 'waiting-answer') {
            throw new Error('no pending offer: run /a2a-connect first, then paste the answer code');
        }
        if (payload.sessionId !== this.pendingSessionId) {
            throw new Error('answer code belongs to a different direct session');
        }
        this.remoteName = peer.name;
        this.remoteFingerprint = peer.fingerprint;
        await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        this.pendingSessionId = '';
        this.setState('connecting');
        return {};
    }
    send(content) {
        if (!this.dc || this.dc.readyState !== 'open') {
            throw new Error('direct session is not connected');
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_MESSAGE_BYTES) {
            throw new Error(`direct message exceeds ${MAX_MESSAGE_BYTES} bytes`);
        }
        const id = `direct-${randomUUID()}`;
        const sentAt = Date.now();
        const wire = JSON.stringify({ type: 'message', id, content, ts: sentAt });
        if (Buffer.byteLength(wire, 'utf8') > MAX_WIRE_BYTES) {
            throw new Error(`encoded direct message exceeds ${MAX_WIRE_BYTES} bytes`);
        }
        this.dc.send(wire);
        this.deliveryReceipts.set(id, { id, status: 'sent', updatedAt: sentAt });
        return { id };
    }
    acknowledge(deliveryId, status) {
        if (!this.dc || this.dc.readyState !== 'open')
            return;
        this.dc.send(JSON.stringify({ type: 'receipt', id: deliveryId, status, ts: Date.now() }));
    }
    async diagnose() {
        const rtc = await loadRtc(this.opts.rtcModule);
        const pc = new rtc.RTCPeerConnection(this.iceConfig());
        try {
            pc.createDataChannel('a2a-diagnostics');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await this.waitIceGathering(pc);
            this.captureCandidates(pc.localDescription?.sdp ?? '');
            return this.diagnostics;
        }
        finally {
            pc.close();
        }
    }
    async close() {
        try {
            this.dc?.close();
            this.pc?.close();
        }
        catch {
            // Closing a torn-down connection is fine.
        }
        this.dc = undefined;
        this.pc = undefined;
        this.remoteName = '';
        this.remoteFingerprint = '';
        this.pendingSessionId = '';
        this.setState('closed');
    }
    iceConfig() {
        const policy = this.opts.icePolicy ?? 'stun';
        if (policy === 'strict')
            return { iceServers: [] };
        if (policy === 'stun') {
            const urls = this.opts.stunServers ?? DEFAULT_STUN;
            return { iceServers: urls.length > 0 ? [{ urls }] : [] };
        }
        const urls = this.opts.turnServers ?? [];
        if (urls.length === 0)
            throw new Error('relay ICE policy requires at least one TURN server');
        return {
            iceTransportPolicy: 'relay',
            iceServers: [{ urls, username: this.opts.turnUsername, credential: this.opts.turnCredential }],
        };
    }
    setState(state) {
        if (this.currentState === state)
            return;
        this.currentState = state;
        this.opts.onStateChange?.(state);
    }
    watchConnection(pc) {
        pc.onconnectionstatechange = () => {
            if (pc !== this.pc)
                return;
            if (pc.connectionState === 'failed')
                this.setState('failed');
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                if (this.currentState === 'connected')
                    this.setState('closed');
            }
        };
    }
    attachChannel(dc) {
        this.dc = dc;
        dc.onopen = () => this.setState('connected');
        dc.onclose = () => {
            if (this.currentState === 'connected')
                this.setState('closed');
        };
        dc.onmessage = (evt) => {
            let raw;
            try {
                const wire = String(evt.data);
                if (Buffer.byteLength(wire, 'utf8') > MAX_WIRE_BYTES)
                    return;
                raw = JSON.parse(wire);
            }
            catch {
                return;
            }
            if (typeof raw !== 'object' || raw === null)
                return;
            const r = raw;
            if (r.type === 'receipt') {
                if (typeof r.id === 'string' &&
                    (r.status === 'quarantined' || r.status === 'accepted' || r.status === 'rejected')) {
                    const existing = this.deliveryReceipts.get(r.id);
                    if (existing) {
                        existing.status = r.status;
                        existing.updatedAt = typeof r.ts === 'number' ? r.ts : Date.now();
                    }
                }
                return;
            }
            if (typeof r.content !== 'string' ||
                r.content.length === 0 ||
                Buffer.byteLength(r.content, 'utf8') > MAX_MESSAGE_BYTES)
                return;
            if (!this.remoteName || !this.remoteFingerprint)
                return;
            const remoteId = typeof r.id === 'string' && r.id.length > 0 && r.id.length <= MAX_MESSAGE_ID_CHARS
                ? r.id
                : randomUUID();
            const peerScope = this.remoteFingerprint.slice('ed25519:'.length, 'ed25519:'.length + 12);
            const result = this.opts.onMessage({
                id: `direct-${peerScope}-${remoteId}`,
                from: this.remoteName,
                channel: 'direct',
                content: r.content,
                ts: typeof r.ts === 'number' ? r.ts : Date.now(),
                security: 'direct',
                route: 'direct',
                deliveryId: remoteId,
            });
            const status = result === 'rejected-too-large' || result === 'rejected-inbox-full' ? 'rejected' : 'quarantined';
            if (this.dc?.readyState === 'open') {
                this.dc.send(JSON.stringify({ type: 'receipt', id: remoteId, status, ts: Date.now() }));
            }
        };
    }
    verifyPeer(payload) {
        const fingerprint = verifyPayload(payload);
        if (!fingerprint)
            throw new Error('connect code signature is invalid');
        const trustedPeers = typeof this.opts.trustedPeers === 'function' ? this.opts.trustedPeers() : this.opts.trustedPeers;
        const expectedName = trustedPeers.get(fingerprint);
        if (!expectedName) {
            throw new Error(`untrusted peer ${payload.name} (${fingerprint}); add "${payload.name}=${fingerprint}" to trustedPeers`);
        }
        if (payload.name !== expectedName) {
            throw new Error(`trusted peer name mismatch for ${fingerprint}: expected "${expectedName}", got "${payload.name}"`);
        }
        return { name: expectedName, fingerprint };
    }
    captureCandidates(sdp) {
        const candidates = sdp.split(/\r?\n/).filter((line) => line.startsWith('a=candidate:'));
        this.lastCandidateTypes = [...new Set(candidates.flatMap((line) => {
                const match = /\styp\s(host|srflx|prflx|relay)(?:\s|$)/.exec(line);
                return match?.[1] ? [match[1]] : [];
            }))];
        this.lastProtocols = [...new Set(candidates.flatMap((line) => {
                const parts = line.trim().split(/\s+/);
                return parts[2] ? [parts[2].toLowerCase()] : [];
            }))];
    }
    waitIceGathering(pc) {
        if (pc.iceGatheringState === 'complete')
            return Promise.resolve();
        const timeout = this.opts.gatherTimeoutMs ?? 8_000;
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, timeout);
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                }
            };
        });
    }
}
