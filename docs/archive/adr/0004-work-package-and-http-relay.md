# ADR 0004: Work Package is the direct collaboration unit

- Status: accepted
- Date: 2026-08-17

## Context

Agent collaboration must not depend on GitHub, GitLab, Feishu, or another
content host. A sender needs to transfer an instruction plus ordinary files or
a source directory directly. A result must be able to return the same way.

## Decision

Version 0.2 adds one product extension, `work-package/v1`. A Work Package is a
flat, deterministic manifest plus encrypted chunk messages. It has two kinds:
`request` and `result`. A request reuses the existing `task.proposal` and
`work.package` capability; a result references the original task. Both use the
same file schema and E2EE envelope.

The outer frame protocol remains `dsh-a2a-messenger/0.1`, schema version `1`, so
0.1 peers can reject unknown inner message types without misreading the
cryptographic envelope. A package is limited to 1,024 regular files, 64 MiB in
total, 32 MiB per file, and 96 KiB plaintext chunks. Directories are flattened
to sorted relative POSIX paths. Symlinks, archives-as-containers, device files,
absolute/traversal/control-character paths, and case-fold collisions are
rejected.

Received bytes remain staged in the endpoint's local SQLite database. They are
materialized only after explicit local approval, into a fresh package-named
directory, with digest/length verification, mode `0600`, and no overwrite.
Receiving or materializing bytes never executes them and never grants a tool
capability.

The first network transport is a small self-hosted HTTP relay backed by SQLite.
It exposes authenticated publish/pull and unauthenticated health only. Each
device has a separate random bearer credential; the relay stores only its hash,
derives the mailbox from the credential, and checks that a publisher's signed
sender device matches the credential. Recipients must be active registered
devices, HTTP pulls are small cursor-based batches, and per-mailbox,
per-sender/mailbox, and global row quotas bound storage. The raw provisioning
file remains an operator secret; only the relay database stores hashes. This
relay credential is transport access,
not the agent identity or a user-visible collaboration handle.

## Consequences

- Code and arbitrary regular files can move without a forge or cloud storage.
- The relay still sees routing/timing/size metadata, never package plaintext.
- HTTP is loopback-only by default. A non-loopback development bind requires an
  explicit insecure opt-in; production deployment requires TLS termination.
- There is no resumable per-chunk upload endpoint, content-addressed blob store,
  archive extraction, automatic project merge, or multi-writer group consensus
  in this release.
- Work Package v1 requires per-sender publish order so the manifest precedes its
  chunks. A hostile relay may violate this and cause availability loss, but
  signatures, device binding, hashes, local policy, and approval still fail
  closed.
