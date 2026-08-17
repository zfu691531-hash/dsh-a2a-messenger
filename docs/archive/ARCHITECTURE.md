# Architecture

`dsh-a2a-messenger` is a cross-device network and collaboration layer. Version
0.2 adds direct Work Package transfer over a self-hosted HTTP+SQLite relay; the
public-Internet and two-physical-device path remains unverified.

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
      |                                      |
      +-> Work Package quarantine            +-> loopback or HTTP+SQLite
              | local approval
              v
        fresh verified directory
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
  mailbox with at-least-once behavior. A conforming v1 Transport preserves
  publish order for frames from one sender device; no global order is required.
- `http-relay.mjs`: authenticated HTTP adapter over the same opaque mailbox
  semantics; device credentials are transport access, never agent identity.
- `work-package.mjs`: deterministic direct file/code packaging, validation,
  encrypted chunk descriptors, quarantine materialization, and hard quotas.
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

Work Package bytes follow the same authority rule. Receiving a package only
stages authenticated bytes. Local approval may materialize them into a new
isolated directory, but does not insert them into an Agent prompt, write into an
existing repository, merge code, or execute a tool. Forge adapters, memory,
voice, gesture, and same-machine DSH/Codex collaboration depend only on future
versioned capability/event contracts; Messenger does not depend on their
internal storage, sockets, processes, or file layout.

The package origin is bound to the exact `agentId`, `deviceId`, and device key
version through staging and materialization. Device revocation or rotation
therefore invalidates a pending package from the old origin even when another
device of the same Agent remains active. Chunk bytes are omitted from the
generic inbox copy and removed from staging after successful materialization;
the manifest/task/audit record remains as metadata evidence.

Filesystem materialization uses a durable intent followed by a fresh staging
directory and atomic rename. Restart recovery only verifies and records an
already-completed exact result; it never repeats unknown writes automatically.
If no exact final result exists, the package becomes `blocked`, package-scoped
temporary directories are cleaned, and an explicit retry must pass current
policy plus exact origin-device authorization again.

See `docs/adr`, `docs/PROTOCOL.md`, and `docs/THREAT_MODEL.md` for decisions,
wire invariants, and security limits.
