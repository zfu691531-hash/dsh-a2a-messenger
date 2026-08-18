import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/**
 * Persistent quarantine inbox. Incoming messages are stored here and are
 * NEVER model-visible until the local user explicitly accepts them.
 * Backed by a single JSON file written atomically (tmp file + rename).
 */
export class QuarantineInbox {
    filePath;
    items = new Map();
    maxPending;
    maxContentBytes;
    maxDecided;
    decisionListeners = new Set();
    constructor(filePath, options) {
        this.filePath = filePath;
        this.maxPending = options.maxPending ?? 200;
        this.maxContentBytes = options.maxContentBytes ?? 64 * 1024;
        this.maxDecided = options.maxDecided ?? 500;
    }
    static open(filePath, options = {}) {
        const inbox = new QuarantineInbox(filePath, options);
        if (existsSync(filePath)) {
            try {
                const raw = JSON.parse(readFileSync(filePath, 'utf8'));
                if (Array.isArray(raw.messages)) {
                    for (const item of raw.messages) {
                        const m = item;
                        if (m && typeof m.id === 'string' && typeof m.content === 'string') {
                            inbox.items.set(m.id, m);
                        }
                    }
                }
            }
            catch {
                // Corrupted file: start fresh; the next persist overwrites it.
            }
        }
        return inbox;
    }
    add(msg) {
        if (this.items.has(msg.id))
            return 'duplicate';
        if (Buffer.byteLength(msg.content, 'utf8') > this.maxContentBytes)
            return 'rejected-too-large';
        if (this.pendingCount() >= this.maxPending)
            return 'rejected-inbox-full';
        this.items.set(msg.id, { ...msg, receivedAt: Date.now(), status: 'pending' });
        this.persist();
        return 'added';
    }
    get(id) {
        return this.items.get(id);
    }
    listPending() {
        return [...this.items.values()]
            .filter((m) => m.status === 'pending')
            .sort((a, b) => a.receivedAt - b.receivedAt);
    }
    pendingCount() {
        let n = 0;
        for (const m of this.items.values())
            if (m.status === 'pending')
                n++;
        return n;
    }
    accept(id) {
        return this.decide(id, 'accepted');
    }
    reject(id) {
        return this.decide(id, 'rejected');
    }
    onDecision(listener) {
        this.decisionListeners.add(listener);
        return () => this.decisionListeners.delete(listener);
    }
    /** Decide every pending message at once; returns the affected messages. */
    decideAll(status) {
        const affected = [];
        for (const m of this.listPending()) {
            m.status = status;
            m.decidedAt = Date.now();
            affected.push(m);
            this.notifyDecision(m);
        }
        if (affected.length > 0)
            this.persist();
        return affected;
    }
    decide(id, status) {
        const m = this.items.get(id);
        if (!m || m.status !== 'pending')
            return undefined;
        m.status = status;
        m.decidedAt = Date.now();
        this.persist();
        this.notifyDecision(m);
        return m;
    }
    notifyDecision(message) {
        for (const listener of this.decisionListeners)
            listener(message);
    }
    persist() {
        this.pruneDecided();
        mkdirSync(dirname(this.filePath), { recursive: true });
        const payload = JSON.stringify({ version: 1, messages: [...this.items.values()] }, null, 2);
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, payload, 'utf8');
        renameSync(tmp, this.filePath);
    }
    pruneDecided() {
        const decided = [...this.items.values()]
            .filter((m) => m.status !== 'pending')
            .sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0));
        const excess = decided.length - this.maxDecided;
        for (let i = 0; i < excess; i++) {
            const victim = decided[i];
            if (victim)
                this.items.delete(victim.id);
        }
    }
}
