export class EchoCapabilityAdapter {
  constructor() { this.calls = 0; this.seen = new Map(); }
  descriptor() { return { id: 'demo.echo', version: '1', risk: 'low' }; }
  async execute(input, idempotencyKey) {
    if (this.seen.has(idempotencyKey)) return this.seen.get(idempotencyKey);
    this.calls += 1;
    const result = { echo: input, call: this.calls };
    this.seen.set(idempotencyKey, result);
    return result;
  }
  async recover(idempotencyKey) {
    return this.seen.has(idempotencyKey)
      ? { status: 'completed', result: this.seen.get(idempotencyKey) }
      : { status: 'not_started' };
  }
}

export class CounterCapabilityAdapter {
  constructor() { this.value = 0; this.seen = new Set(); this.results = new Map(); }
  descriptor() { return { id: 'demo.counter', version: '1', risk: 'medium' }; }
  async execute(input, idempotencyKey) {
    if (!this.seen.has(idempotencyKey)) {
      this.seen.add(idempotencyKey);
      this.value += Number(input.amount ?? 1);
    }
    const result = { value: this.value };
    this.results.set(idempotencyKey, result);
    return result;
  }
  async recover(idempotencyKey) {
    return this.results.has(idempotencyKey)
      ? { status: 'completed', result: this.results.get(idempotencyKey) }
      : { status: 'not_started' };
  }
}

export class GestureInputAdapter {
  toIntent({ gestureId, confidence, timestamp }, capability) {
    if (!gestureId || typeof confidence !== 'number' || !timestamp) throw new Error('invalid_gesture_event');
    return {
      source: 'gesture',
      capability,
      sensorEvidence: { gestureId, confidence, timestamp },
      authorization: null,
      requiresLocalPolicy: true,
    };
  }
}
