/** Disabled async mailbox used when the plugin runs in direct-only mode. */
export class NoneTransport {
    kind = 'none';
    currentState = 'idle';
    get state() {
        return this.currentState;
    }
    start(handlers) {
        handlers.onStateChange?.(this.currentState);
    }
    async stop() {
        this.currentState = 'stopped';
    }
    async send(_input) {
        throw new Error('async mailbox transport is disabled; use a2a_direct_send');
    }
    async peers() {
        return [];
    }
    async channels() {
        return [];
    }
}
