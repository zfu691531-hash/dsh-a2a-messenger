# ADR 0002: Device keys, untrusted relay, and single-writer group control

- Status: accepted for MVP
- Date: 2026-08-16

## Decision

The relay is untrusted for content. Devices sign envelopes with Ed25519 and
encrypt content with AES-256-GCM epoch keys. A controller-signed membership
commit is the single writer for group state. Every membership change advances
both `membershipEpoch` and `keyEpoch`; a device revocation advances `keyEpoch`.
The epoch key is wrapped separately to each active X25519 device key.

`agentId` and `deviceId` are random stable identifiers. Display names are never
identities. A root-signed device certificate binds each device signing and
encryption key to an agent and monotonically increasing key version. Contact
verification is out-of-band fingerprint verification.

## Why

This gives a deterministic, testable MVP without pretending to implement MLS,
Double Ratchet, distributed consensus, or key transparency. A malicious
controller can fork group history; clients detect and quarantine a broken hash
chain but cannot automatically heal it.

## Consequences and honest limits

- Removal prevents access to future epochs; it cannot erase keys or plaintext a
  removed device already possessed.
- The relay sees mailbox identifiers, time, size, and delivery attempts.
- The MVP has no forward secrecy or post-compromise security.
- Public-network TLS, NAT traversal, mobile devices, and real multi-computer
  operation are not verified in v0.1.0.
