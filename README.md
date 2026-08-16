# DSH A2A Messenger

[简体中文](README.zh-CN.md)

DSH A2A Messenger is an experimental, self-hostable communication layer for
agents on different devices. Version `0.1.0` provides stable agent/device
identity, direct and group conversations, encrypted envelopes, reliable
at-least-once delivery, explicitly authorized Context Capsules, and a guarded
capability-task state machine.

> **Validation status:** the MVP has been exercised only with the local
> loopback transport. Public-internet operation and communication between real
> devices have **not** been verified. This software is not production-ready.

## Scope and boundaries

Messenger owns protocol framing, transport abstraction, delivery state,
conversation membership, and authorization hand-off. It deliberately does not
own long-term memory, audio I/O, sensor interpretation, or orchestration prompt
templates.

- A message is never tool authorization. Remote work requires capability
  negotiation, the receiving device's local policy, and human approval when
  required.
- Long-term memory remains authoritative in the memory plugin. Messenger moves
  only a user-authorized, minimum-disclosure Context Capsule; received capsules
  stay quarantined and untrusted until explicitly approved.
- Audio plugins own ASR, TTS, and WebRTC. This MVP carries structured messages,
  attachment references, and task events only.
- Gesture plugins are local input adapters. A gesture event must first become a
  capability intent and then pass normal policy/approval. Confidence is neither
  identity nor permission.
- `dsh-codex-collab` remains the same-device DSH↔Codex bridge. Integration is
  through versioned adapter/capability contracts, never internal storage.

## Standards relationship

The interoperability baseline is Linux Foundation A2A wire version **1.0**,
reviewed against specification patch **v1.0.1 dated 2026-05-26**. The project
reuses A2A concepts such as Agent Card, Message, Task, Artifact, Parts,
extensions, and version negotiation.

The current adapter is mapper-only. It does not implement an A2A HTTP/JSON-RPC,
gRPC, or SSE server and has not passed an official SDK conformance suite. No
wire-level A2A conformance claim is made for `0.1.0`.

Contacts, stable device identity, conversations/groups, membership and key
epochs, E2EE, delivery cursors, approvals, and Context Capsules are Messenger
product extensions—not standard A2A fields. See [the protocol](docs/PROTOCOL.md)
and [architecture decisions](docs/adr/).

## Security posture

The loopback MVP encrypts message bodies end to end and treats the relay as
untrusted for content. The relay still observes delivery metadata. Keys and
plaintext are excluded from audit logs, replay/duplicate checks are durable,
membership changes advance the key epoch, attachments are bounded references
whose future consumers must verify hash and length, and tool execution is
deny-by-default.

This release does **not** implement MLS, Double Ratchet, forward secrecy, key
transparency, hardware attestation, or production key management. E2EE does not
hide traffic metadata or repair a compromised endpoint. Retraction/deletion is
best-effort processing and cannot erase copies already viewed, exported, or
backed up. Read [SECURITY.md](SECURITY.md) and the
[threat model](docs/THREAT_MODEL.md) before evaluating the MVP.

## Requirements

- Node.js 22.13 or newer (`node:sqlite` without an experimental flag)
- npm
- A local filesystem suitable for durable MVP state

## Install and remove

Install dependencies and expose the development CLI:

```sh
npm run install:local
```

Remove the global development link:

```sh
npm run uninstall:local
```

The command name is `dsh-a2a`.

## Verify and demonstrate

Run environment and state checks:

```sh
dsh-a2a doctor
```

Run the local loopback demonstration:

```sh
dsh-a2a demo
```

Run automated tests and the release gate:

```sh
npm test
npm run release:check
```

The demo is evidence for a single-machine loopback flow only. It is not evidence
of public relay deployment, NAT traversal, or interoperability across physical
devices.

Node's built-in SQLite module still emits an experimental API warning in the
minimum supported runtime; this is another reason the MVP is not production
ready.

## Protocol guarantees in the MVP

- Stable random `agentId` and `deviceId`; display names are non-authoritative.
- Root-signed device credentials, rotation, joining, revocation, and verified
  contacts.
- Direct and group conversations with membership/key epochs, roles, invites,
  removals, and hash-chained membership commits.
- Signed, encrypted envelopes with immutable retry frames, per-sender ordering,
  mailbox cursors, expiry, restart recovery, and durable deduplication.
- At-least-once transport without duplicate local task execution when adapters
  honor the supplied idempotency contract.
- Capability tasks with `proposed`, `accepted`, `running`, `blocked`,
  `completed`, `failed`, and `cancelled` states.
- Metadata-only audit events using trace and correlation identifiers.

No global total order is claimed. A removed group member loses future epoch
access, but previously obtained plaintext cannot be revoked.

## Project status

`0.1.0` is an MVP for protocol and security-boundary evaluation. Consult
[ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[CHANGELOG.md](CHANGELOG.md). The exact test scope and unverified boundaries are
recorded in [docs/VALIDATION.md](docs/VALIDATION.md). Please use responsible
disclosure for security issues rather than filing a public exploit report.

## License

MIT. See [LICENSE](LICENSE).
