# DSH A2A Messenger

[简体中文](README.zh-CN.md)

DSH A2A Messenger is an experimental, self-hostable communication layer for
agents on different devices. Version `0.2.0` provides stable agent/device
identity, direct and group conversations, encrypted envelopes, reliable
at-least-once delivery, explicitly authorized Context Capsules, and a guarded
capability-task state machine. Its new Work Package transfers a task instruction
plus a code/file directory directly and returns results the same way, without
requiring GitHub, GitLab, or another content host.

> **Validation status:** loopback and authenticated HTTP+SQLite transport have
> been exercised end to end on one computer. Public-internet operation and
> communication between two physical devices have **not** been verified. This
> software is not production-ready.

## The core collaboration flow

1. One Agent proposes a task and sends a Work Package containing ordinary files
   or a source directory.
2. The receiver validates identity, membership, signatures, file declarations,
   and local policy. Bytes stay in quarantine.
3. The local user approves materialization. Files are copied to a new isolated
   directory; they are not merged or executed automatically.
4. The receiving Agent can return its result as another Work Package bound to
   the original task.

Chunking, retry, encryption, and the offline queue are transport details. The
user-facing object remains one Work Package.

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
wire-level A2A conformance claim is made for `0.2.0`.

Contacts, stable device identity, conversations/groups, membership and key
epochs, E2EE, delivery cursors, approvals, and Context Capsules are Messenger
product extensions—not standard A2A fields. See [the protocol](docs/PROTOCOL.md)
and [architecture decisions](docs/adr/).

## Security posture

The MVP encrypts message and Work Package bodies end to end and treats the relay as
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

Run direct code transfer and result return over an authenticated local HTTP
relay:

```sh
dsh-a2a work-demo
```

Generate per-device relay credentials and start the self-hosted relay:

```sh
dsh-a2a relay-token --device-id YOUR-DEVICE-UUID
cp examples/relay-credentials.example.json relay-credentials.json
chmod 600 relay-credentials.json
dsh-a2a relay-serve --credentials relay-credentials.json --db relay.db
```

Copy the generated 43-character token into the local credential file in place
of `REPLACE_ME`. The live file is gitignored and the release gate rejects it;
it contains raw bearer credentials even though the relay database stores only
their hashes.

The credential is relay access, not the Agent identity or a user-visible
collaboration handle. The relay binds to `127.0.0.1` by default. Non-loopback
plain HTTP requires `--allow-insecure-network` and is for controlled development
only; real deployment needs TLS termination.

Run automated tests and the release gate:

```sh
npm test
npm run release:check
```

The demos are evidence for single-machine loopback/HTTP flows only. The library
contains the network transport, but this release does not include a finished
persistent pairing UI/CLI. Actual multi-device use therefore requires an
integrator to persist verified identities/conversations through the public
module APIs. It is not evidence of public relay deployment, NAT traversal, or
physical-device interoperability.

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
- Direct Work Packages with deterministic manifests, encrypted chunks, sender
  binding, offline/restart recovery, local approval, expiry/staging quotas, and
  verified no-overwrite materialization.
- Replaceable loopback and authenticated HTTP+SQLite transports.
- Work Package staging is bound to the exact sender device/key version;
  successful materialization removes staged chunk bytes, while cursor-based
  HTTP pulls are limited to 16 frames per request.
- Interrupted materialization is restart-reconciled by full result verification;
  unknown output becomes blocked and requires an explicit policy/device-checked
  retry instead of silent re-execution.

No global total order is claimed. A removed group member loses future epoch
access, but previously obtained plaintext cannot be revoked.

## Project status

`0.2.0` is an MVP for protocol, direct-file collaboration, and security-boundary evaluation. Consult
[ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[CHANGELOG.md](CHANGELOG.md). The exact test scope and unverified boundaries are
recorded in [docs/VALIDATION.md](docs/VALIDATION.md). Please use responsible
disclosure for security issues rather than filing a public exploit report.

## License

MIT. See [LICENSE](LICENSE).
