# ADR 0003: Messages propose; local policy authorizes

- Status: accepted
- Date: 2026-08-16

## Decision

Remote messages, Agent Cards, capability declarations, Context Capsules, and
sensor events are untrusted proposals. Execution requires all of:

1. valid envelope, device certificate, membership epoch, and replay checks;
2. negotiated capability descriptor;
3. receiving device's deny-by-default policy;
4. human approval where the local policy requires it;
5. an idempotency-aware local adapter.

The product task states are `proposed`, `accepted`, `running`, `blocked`,
`completed`, `failed`, and `cancelled`. They are product extension states, not
invented A2A `TaskState` values. The A2A adapter maps only where semantics match.

## Dependency direction

- `dsh-codex-collab`: same-machine bridge only; Messenger may call a future
  versioned capability adapter and never its internal storage.
- memory plugin: owns long-term memory; Messenger only transports explicit
  Context Capsules.
- realtime voice plugin: owns audio I/O; Messenger transports structured events
  and attachment references, not ASR/TTS/WebRTC.
- gesture plugin: local input source only. Its public `gestureId`, `confidence`,
  and `timestamp` become a capability intent and never an identity, approval, or
  remote command. Messenger does not depend on gesture IPC, PID, socket/token,
  Swift state machine, or internal files.
- collaboration Skill: owns orchestration knowledge and prompts; Messenger owns
  protocol and transport.
