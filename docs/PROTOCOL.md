# Messenger product protocol 0.2

This document defines the product protocol `dsh-a2a-messenger/0.1`, schema
version `1`, plus the `work-package/v1` inner-message extension. The encrypted
frame stays wire-compatible with 0.1. This is an extension layer, not the Linux
Foundation A2A standard.

## A2A relationship

Reviewed on 2026-08-16 against A2A wire version `1.0` and specification v1.0.1
(2026-05-26). v1.0.0 (2026-03-12) was the first stable release. The authoritative
data model is the `lf.a2a.v1` proto. Reused concepts are Agent Card, Message,
Task, Artifact, Parts, extension declaration, and version negotiation.

Google announced A2A on 2025-04-09; the Linux Foundation launched the neutral
A2A project on 2025-06-23. The reviewed first-party sources are the
[current specification](https://a2a-protocol.org/latest/specification/),
[official releases](https://github.com/a2aproject/A2A/releases),
[normative proto](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto),
[Google launch announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/),
and [Linux Foundation project announcement](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents).

Product extensions use these URIs; a breaking change creates a new URI:

- `https://dsh-a2a.dev/extensions/messenger-envelope/v1`
- `https://dsh-a2a.dev/extensions/identity-device/v1`
- `https://dsh-a2a.dev/extensions/group-membership/v1`
- `https://dsh-a2a.dev/extensions/context-capsule/v1`
- `https://dsh-a2a.dev/extensions/capability-task/v1`
- `https://dsh-a2a.dev/extensions/work-package/v1`

The following are not standard A2A fields: stable agent/device identity,
contacts, conversations, groups, membership/key epochs, E2EE, delivery cursors,
Context Capsule, approvals, and product task states.

## Envelope

The relay-visible outer frame contains protocol/schema versions, message and
conversation IDs, sender device identity, recipient device mailboxes, creation
and expiry times, membership/key epochs, sender sequence, trace/correlation IDs,
AEAD metadata, ciphertext hash, ciphertext, and signature. The signature covers
the canonical protected header and ciphertext hash. The protected header is AEAD
additional authenticated data.

The encrypted inner body contains type, sender and recipient agent IDs, content
hash, payload, optional reply/thread links, capability intent, a sealed Context
Capsule wrapper, attachment references, and protocol ACK/error details. Capsule
plaintext uses a fresh content key wrapped only to devices of its explicit
`allowedRecipients`; the group epoch key alone is insufficient to recover it.

The JSON Schema is in `schemas/envelope.schema.json`. Implementations reject
unknown protocol/schema versions rather than guessing.

## Ordering, duplicate delivery, and recovery

- The relay provides at-least-once delivery and monotonically increasing
  per-mailbox delivery cursors.
- Sender sequence is monotonic per `(conversationId, senderDeviceId, keyEpoch)`.
- Receivers persist uniqueness of `messageId` and
  `(conversationId, senderDeviceId, keyEpoch, senderSeq)` in the same transaction
  as inbox/task effects. Relay ACK/cursor advancement happens after commit.
- Retries reuse the exact immutable ciphertext frame; they never reuse an AEAD
  nonce for different plaintext.
- Ordering is deterministic per sender. No global total message order is
  claimed. Membership commits have a controller-defined total order and hash
  chain.
- A future membership/key epoch does not advance the durable cursor; the frame
  is retried after the membership chain catches up. A stale epoch is rejected.
- Expiry stops future processing. Retraction/deletion creates an honest
  tombstone and best-effort local hiding; it cannot make viewed, exported, or
  backed-up copies disappear.

## Membership commits

A commit contains `conversationId`, previous commit hash, membership and key
epochs, full deterministic member/role snapshot, per-device wrapped epoch keys,
operation ID, controller identity, and signature. Clients accept only an
out-of-band-verified and durably pinned controller root, an unbroken hash chain,
and exactly the next membership epoch. The MVP controller/owner is the only
membership writer; roles are conveyed for policy/UI use but do not grant a
second signing authority. Device revocation/rotation is root-signed and advances
the membership and key epochs. Forks and gaps are rejected.

A newly invited member cannot decrypt or validate epochs from before it joined.
It installs the current commit as an explicit checkpoint only when a local trust
decision binds the verified controller fingerprint, conversation ID, invite
operation ID, and invited local agent/device. All later commits extend that
checkpoint normally; no pre-join history authenticity is claimed.

## Context Capsule

Required fields are provenance, source, scope, sensitivity, token and byte
budgets, creation/expiry, retractable flag, summary, original references,
allowed recipients, and content hash. A received capsule starts quarantined. It
is never automatically inserted into system prompts, memory, tool arguments, or
capability negotiation. Approval creates a separate, explicitly untrusted
context view.

## Capability task state machine

Allowed transitions:

```
proposed -> accepted | failed | cancelled
accepted -> running | cancelled
running  -> blocked | completed | failed | cancelled
blocked  -> running | failed | cancelled
```

Each event increments `stateVersion` and records the previous state. A trusted
local approval broker issues a short-lived, single-use token bound to the exact
proposal digest and policy version. The execution claim and transition to
`running` are atomic. A stable idempotency key prevents duplicate local claims.
The sender must still be a current conversation member at execution time.
After restart, only an adapter that durably reports the effect `completed` may
complete automatically; `not_started` or unknown recovery is moved to `blocked`
for explicit local reconciliation and is never silently re-executed.
Recovery reconciles a previously claimed effect before current membership or
policy gates are evaluated, because those gates govern new execution rather
than recording an effect that may already have happened.
Adapters with external side effects must themselves honor idempotency keys or
provide compensation; the generic Messenger cannot promise exactly-once effects
across an arbitrary external system.

Relay quota/backpressure errors leave the frame pending and stop that flush to
preserve sender order; an operator must free capacity before retry. Expired
frames are terminally audited and skipped so they cannot wedge later work.

## Attachment references

MVP messages carry only a bounded HTTPS/IPFS URL, SHA-256 digest, byte length,
media type, and optional encryption metadata. Receivers validate the reference
schema but do not automatically download, open, render, or execute attachments.
Any future approved consumer must verify the declared hash and length against
downloaded bytes before exposing them to a parser, renderer, model, or tool.

## Work Package

A Work Package is the direct collaboration primitive for task instructions,
source code, documents, media, and returned results. It does not require a Git
forge or external object store. A `request` manifest is carried by a
`task.proposal` with capability `work.package`; a `result` manifest is carried
by `work.package.result` and references the same task ID. File bytes use
`work.package.chunk` messages. The manifest schema is
`schemas/work-package.schema.json`.

Files are regular bytes with deterministic relative POSIX paths, length,
SHA-256, media type, and chunk count. Chunks bind package ID, task ID, file path,
index/count, byte length, chunk SHA-256, and the manifest origin's exact device
and key version. The receiver accepts a chunk only after its signed manifest,
stores it idempotently, and marks a package `ready` only after every declared
byte and digest is present. The v1 Transport contract therefore requires
publish order to be preserved for frames from one sender device; a relay that
reorders a chunk before its manifest can make that package unavailable but
cannot bypass signatures, digests, policy, or approval.

The receiver must explicitly approve materialization. Materialization creates a
new isolated directory, verifies the full manifest again, writes regular files
without executable bits, and never overwrites an existing path. Approval allows
bytes to be copied out of quarantine; it does not approve prompts, memory
insertion, parsing, merging, or tool execution.

Before writing, the endpoint durably records the intended final directory. On
restart, `recoverWorkPackageMaterialization` verifies every final path, length,
and SHA-256: an exact atomic-rename result is completed without re-writing;
missing or invalid output is moved to `blocked` and only package-scoped temporary
directories are removed. `retryWorkPackageMaterialization` is an explicit local
action that rechecks current policy and the exact origin device/key membership
before the allowed `blocked -> running` transition. Recovery never silently
re-executes an unknown filesystem effect.

## HTTP relay transport

The v0.2 relay API is intentionally small:

- `GET /v1/health` returns non-sensitive service status;
- `POST /v1/frames` publishes one encrypted frame;
- `GET /v1/mailbox?cursor=N&limit=N` pulls the authenticated device mailbox.

Publish and pull require a per-device bearer credential. The provisioning JSON
contains the raw bearer and must stay mode `0600`, outside version control, and
be deleted when no longer needed. The relay database stores only credential
hashes, derives the pull mailbox from the authenticated device, rejects
unregistered/revoked recipients, and rejects publish frames whose
`senderDeviceId` differs from that device. HTTP pulls are capped at 16 frames;
clients continue through the durable cursor. Per-mailbox, per-sender/mailbox,
and global row quotas bound durable relay allocation.
Credentials grant relay access only; agent identity continues to be the
root/device certificate and signed message envelope.

## A2A conformance boundary

`src/a2a.mjs` is a mapper for Agent Card, Message, Task state, Artifact, headers,
and versioned extensions. Version 0.2.0 does not expose an A2A HTTP/JSON-RPC,
gRPC, or SSE server and has not run against an official SDK conformance suite.
Accordingly, it claims field-level reuse/evaluation, not wire-level A2A server
conformance.
