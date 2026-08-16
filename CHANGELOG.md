# Changelog

All notable changes are documented here. This project follows Semantic
Versioning while the public protocol and extension contracts remain explicitly
versioned.

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
