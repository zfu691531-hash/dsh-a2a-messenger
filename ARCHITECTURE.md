# Architecture

`dsh-a2a-messenger` is a cross-device network and collaboration layer. Its
v0.1.0 executable proof is local loopback only.

```
local input adapters                 remote encrypted frame
 (gesture/voice/skill)                        |
          |                                    v
          v                            verify + replay gate
 capability intent                             |
          |                                    v
          +----> local policy ----> Context Capsule quarantine
                       |                       or
                       v                        v
                human approval ----> idempotent capability adapter

 AgentNode <-> durable outbox/inbox <-> Transport <-> untrusted relay
```

## Modules

- `identity.mjs`: stable agent/device IDs, root-signed device certificates,
  fingerprint verification, encrypted local identity vault.
- `conversation.mjs`: controller-signed group membership hash chain, roles,
  membership/key epochs, per-device X25519 key wrapping.
- `protocol.mjs`: canonical signed and AEAD-encrypted product envelope.
- `store.mjs`: SQLite outbox, inbox, replay keys, cursor, pinned membership
  state/epoch keys, task approvals/execution attempts, capsule, and metadata-only
  audit state.
- `relay.mjs`: replaceable Transport proof using an opaque SQLite loopback
  mailbox with at-least-once behavior.
- `agent.mjs`: integration and receive transaction boundary.
- `policy.mjs`: deny-by-default policy, trusted local approval tokens, product
  task state machine, atomic execution claims/recovery, and recipient-scoped
  Capsule content-key wrapping.
- `a2a.mjs`: isolated A2A 1.0 Agent Card and Task/Message/Artifact mapping.
- `adapters.mjs`: public capability and local-input contracts. No plugin internals.

## Data and authority boundaries

The relay stores only the signed encrypted frame and routing metadata. Local
SQLite stores plaintext inbox data as the trusted endpoint; production clients
should add OS keychain-backed database encryption. Long-term memory remains in
the memory plugin. Capsules are explicit, bounded transfers and are quarantined
on receipt. Messages propose work, while the receiver's local policy and human
approval are the sole authority for execution. Capability descriptors and
approvals are bound to sender, conversation, message, payload, policy version,
and the registered local adapter.

See `docs/adr`, `docs/PROTOCOL.md`, and `docs/THREAT_MODEL.md` for decisions,
wire invariants, and security limits.
