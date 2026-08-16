# Threat model

## Assets and trust zones

Assets are root/device private keys, epoch keys, contact verification state,
plaintext messages and capsules, approval decisions, task effects, and durable
delivery state. The user, local policy engine, and local key vault are trust
anchors. The relay, network, remote agents, received content, attachments,
sensor events, and local plugin adapters are independently compromiseable.

E2EE protects content from the relay, not metadata. The loopback relay stores
the full outer frame and therefore sees stable sender agent/device IDs,
conversation ID, the complete recipient-device set, membership/key epochs,
sender sequence, trace/correlation IDs, creation/expiry time, algorithm, nonce,
ciphertext hash/signature, and ciphertext size. It also sees mailbox, delivery
time, retry/duplicate patterns, and cursor behavior. It can drop, delay,
duplicate, or reorder frames. It cannot forge an accepted frame without a
device key, and replay must not repeat an effect.

## Threats and controls

| Threat | Mandatory control | Residual risk |
| --- | --- | --- |
| Agent/device impersonation | root-signed device cert, stable random IDs, Ed25519 signature, out-of-band contact fingerprint | no key transparency or hardware attestation |
| Replay/duplicate delivery | persistent message and sender-sequence uniqueness before effect, immutable retry frame | bounded tombstone retention needs operational policy |
| Relay reads content | AES-256-GCM E2EE, no plaintext in relay/audit | relay observes social/timing metadata |
| Header/ciphertext tampering | signed canonical header, AEAD AAD, ciphertext/content hashes | implementation bugs remain possible |
| Revoked member/device reads future data | root-signed revocation, durable membership chain, epoch advance and rekey to active devices only | historical access cannot be revoked |
| Group split/fork | controller signature, monotonic epoch, previous hash | malicious controller fork detected but not healed |
| Unauthorized tool call | proposal/provenance-bound descriptor, deny-by-default local policy, single-use trusted approval token, execution-time policy recheck, atomic execution claim | compromised approved adapter may misbehave |
| Prompt injection in capsule | quarantine, budgets, explicit approval, untrusted-data labeling, no automatic prompt/tool insertion | approved text can still influence a model |
| Malicious attachment | bounded reference schema and no auto-fetch/open; future consumers must verify downloaded hash/length before use | fetching, malware scanning, and preview are out of MVP |
| Malicious Work Package path/content | reject traversal, absolute/backslash/control paths, symlinks, non-regular files, case-fold collisions and quota excess; stage encrypted chunks locally; explicit approval; fresh no-overwrite directory; full digest verification; never execute | approved files may still contain malware or prompt injection; no malware scanner in MVP |
| Crash during Work Package materialization | persist intended destination before writing; atomic rename; restart verifies exact paths/lengths/digests and records completed or blocked without re-writing; explicit retry rechecks policy and origin device | local disk corruption or a hostile local administrator remains out of scope |
| Relay credential theft | random per-device bearer credentials, invalid public placeholder, raw provisioning file mode `0600` and gitignored/release-blocked, hash-only relay database, sender-device binding, mailbox derived from credential, TLS required outside explicit development mode | a stolen credential can read queued ciphertext/metadata or submit frames for its transport identity; provisioning JSON remains a local secret |
| Relay resource exhaustion | registered active recipients only; bounded request/frame/HTTP-pull sizes; per-mailbox, per-sender/mailbox, and global row quotas; SQLite transactions | single-process relay has no distributed rate limiter or tenant isolation |
| Secret leakage in logs | metadata-only audit and tests scanning logs | OS/process compromise remains out of scope |
| Gesture spoof/false positive | sensor event converted to intent, then policy/approval; confidence is not authority | physical sensor quality not verified |
| Rollback after restart | pinned controller/root plus membership commit and epoch state persist in SQLite; fork/rollback rejected | disk corruption and hostile local admin out of scope |

## Context Capsule rules

Capsules are external untrusted data even after decryption and signature
verification. Authenticity says who sent bytes, not that instructions are safe.
Budgets and content hash are enforced before storage/approval. A fresh content
key is wrapped only to explicitly allowed recipient devices, even inside group
traffic. Expired, oversized, unknown-schema, or unauthorized-recipient capsules
are rejected; valid received capsules remain quarantined. Retraction is a
best-effort processing instruction, never a cryptographic erasure guarantee.

## Audit privacy

Audit records may contain event kind, local timestamp, pseudonymous agent/device
IDs, message/task IDs, trace/correlation IDs, epoch, outcome, and error code.
They must not contain message/capsule bodies, attachment bytes, credentials,
tokens, private keys, decrypted epoch keys, or human approval secrets.

## Release blockers

- replay or duplicate delivery repeats a task effect;
- a removed member decrypts a new epoch message;
- any execution bypasses policy/required approval;
- invalid signatures, stale epochs, or broken membership chains are accepted;
- relay or audit storage contains test plaintext or secret key material;
- a Work Package escapes quarantine, overwrites a destination, accepts an
  undeclared/corrupt/wrong-device chunk, retains chunk bytes outside its
  lifecycle quota, or materializes without local approval or after origin
  device revocation;
- HTTP authentication can pull another device mailbox or publish as another
  sender device;
- A2A adapter omits `A2A-Version: 1.0`, invents TaskState values, or represents
  product fields as standard fields;
- required security, restart, and isolation tests fail.
