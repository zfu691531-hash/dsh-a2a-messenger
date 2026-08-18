import { randomUUID } from 'node:crypto';
import { decodeCode, encodeCode } from './codec.js';
const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
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
    constructor(opts) {
        this.opts = opts;
    }
    get state() {
        return this.currentState;
    }
    get peerName() {
        return this.remoteName;
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
        this.setState('waiting-answer');
        return encodeCode({ v: 1, role: 'offer', name: this.opts.selfName, sdp });
    }
    /**
     * Paste a connect code from the peer.
     * - Offer code: joins the session; returns the answer code to send back.
     * - Answer code: completes a session started with {@link createOffer}.
     */
    async accept(code) {
        const payload = decodeCode(code);
        if (!payload)
            throw new Error('invalid connect code');
        if (payload.role === 'offer') {
            if (this.pc)
                await this.close();
            const rtc = await loadRtc(this.opts.rtcModule);
            this.remoteName = payload.name;
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
            return { answerCode: encodeCode({ v: 1, role: 'answer', name: this.opts.selfName, sdp }) };
        }
        // Answer code path.
        if (!this.pc || this.currentState !== 'waiting-answer') {
            throw new Error('no pending offer: run /a2a-connect first, then paste the answer code');
        }
        this.remoteName = payload.name;
        await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        this.setState('connecting');
        return {};
    }
    send(content) {
        if (!this.dc || this.dc.readyState !== 'open') {
            throw new Error('direct session is not connected');
        }
        const id = `direct-${randomUUID()}`;
        this.dc.send(JSON.stringify({ id, name: this.opts.selfName, content, ts: Date.now() }));
        return { id };
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
        this.setState('closed');
    }
    iceConfig() {
        const urls = this.opts.stunServers ?? DEFAULT_STUN;
        return { iceServers: urls.length > 0 ? [{ urls }] : [] };
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
                raw = JSON.parse(String(evt.data));
            }
            catch {
                return;
            }
            if (typeof raw !== 'object' || raw === null)
                return;
            const r = raw;
            if (typeof r.content !== 'string' || r.content.length === 0)
                return;
            const from = typeof r.name === 'string' && r.name.length > 0
                ? r.name
                : this.remoteName || 'direct-peer';
            this.opts.onMessage({
                id: typeof r.id === 'string' ? r.id : `direct-${randomUUID()}`,
                from,
                channel: 'direct',
                content: r.content,
                ts: typeof r.ts === 'number' ? r.ts : Date.now(),
            });
        };
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
