# Changelog

All notable changes are documented here. This project follows Semantic
Versioning while the public protocol and extension contracts remain explicitly
versioned.

## [0.2.0] - 2026-08-17

### Added

- Direct Work Package transfer for task instructions, source trees, arbitrary
  regular files, and returned result directories without GitHub/GitLab or an
  external blob store.
- Deterministic manifests and bounded encrypted 96 KiB chunks with 64 MiB total,
  32 MiB per-file, and 1,024-file limits.
- Explicit quarantine approval, policy/task binding, sender-bound chunks,
  digest verification, no-overwrite materialization, expiry, and aggregate
  staging quotas.
- Authenticated self-hosted HTTP+SQLite relay with per-device credential hashes,
  mailbox isolation, sender-device binding, and loopback-safe defaults.
- `dsh-a2a work-demo`, `relay-token`, and `relay-serve` commands.

### Changed

- Transport publish/pull and Agent synchronization are asynchronous so local
  and network transports share one contract.
- A2A extension declarations now include `work-package/v1`; A2A wire negotiation
  remains version `1.0`, and the encrypted outer frame remains protocol `0.1`.
- Work Package manifests/chunks/materialization now bind the exact origin device
  and key version; canonical frame times prevent expiry-format bypasses.
- Chunk bytes are omitted from the generic inbox and deleted from staging after
  successful materialization.
- Interrupted materialization persists its intended destination, reconciles an
  exact atomic-rename result after restart, otherwise blocks and permits only an
  explicit policy/device-authorized retry.
- HTTP relay recipients must be active registered devices; small cursor pulls,
  per-sender/mailbox and global quotas bound resource use. Known/example or
  malformed bearer tokens fail closed, and live credential files are ignored
  and release-blocked.

### Validation limits

- HTTP request/result transfer is tested end to end on one machine only.
- Public Internet, NAT traversal, TLS deployment, and two physical devices have
  not been tested. A ready-made persistent pairing UI/CLI is not included.

## [0.1.0] - 2026-08-16

### Added

- Initial local-loopback MVP for stable agent/device identities and verified
  contacts.
- Direct and group conversations with roles, membership/key epochs, invitation,
  removal, and convergent hash-chained membership state.
- Signed E2EE envelopes, offline queueing, retry, mailbox cursors, expiry,
  persistent deduplication, replay defense, and restart recovery.
- Quarantined, budgeted Context Capsules with provenance, scope, sensitivity,
  TTL, references, recipient restrictions, and best-effort retraction metadata.
- Capability negotiation and a policy/approval-gated task state machine.
- Reference-only attachments with digest and length verification.
- Metadata-only audit events, a transport abstraction, CLI doctor, local demo,
  tests, and release checks.
- Explicit Linux Foundation A2A wire 1.0 mapping, reviewed against specification
  patch v1.0.1 dated 2026-05-26; Messenger product extensions remain separate
  from standard A2A fields.
- Pinned and restart-durable controller/membership authority, authenticated
  device revocation/rotation, and future-epoch cursor recovery.
- Recipient-scoped Capsule content-key wrapping and strict schema/hash/budget
  validation.
- Proposal/provenance-bound capability descriptors, single-use local approval
  tokens, execution-time policy rechecks, and atomic recoverable execution
  claims.
- Strict frame/fanout/attachment bounds, relay mailbox quotas, and fixed
  metadata-only audit error codes.
- Conservative crash reconciliation that blocks when durable adapter evidence
  is absent, execution-time sender membership checks, and atomic approvals.
- Node.js 22.13 minimum runtime and stronger scrypt vault parameters.

### Security limitations

- This release is not production-ready and has only been validated on one
  machine using loopback transport.
- Public-internet relay operation and real cross-device communication are not
  verified.
- MLS, Double Ratchet, forward secrecy, key transparency, hardware attestation,
  and production-grade key management are not implemented.
- Retraction/deletion cannot erase content already viewed, exported, or backed
  up; the relay can observe traffic metadata.
