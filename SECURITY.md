# Security policy

## Supported versions

DSH A2A Messenger is pre-production software. Security fixes are provided only
for the latest `0.1.x` release line on a best-effort basis. No release currently
has a production-support commitment.

| Version | Supported |
| --- | --- |
| 0.1.x | Best effort |
| < 0.1 | No |

## Reporting a vulnerability

Do not open a public issue containing exploit details, secrets, personal data,
or live relay information. Use GitHub's private vulnerability reporting for the
repository when available. If it is unavailable, open a public issue requesting
a private security contact without disclosing technical details.

Include only the minimum material needed to reproduce the issue:

- affected version or commit;
- impact and attacker prerequisites;
- a deterministic local reproduction using synthetic data;
- relevant stack traces with credentials, keys, message bodies, and personal
  paths removed;
- suggested mitigation, if known.

Maintainers will acknowledge a usable report when capacity permits, validate it,
coordinate a fix and disclosure date, and credit reporters who want attribution.
Because this is a community MVP, no fixed response-time SLA is promised.

## Security expectations

The release gate treats the following as blockers:

- duplicate or replayed delivery repeats an execution effect;
- a revoked member can decrypt a message from a later group key epoch;
- capability execution bypasses local policy or required human approval;
- invalid signatures, stale epochs, or broken membership chains are accepted;
- message/capsule plaintext, credentials, tokens, or private keys appear in
  relay or audit storage;
- received Context Capsules are automatically inserted into prompts, memory, or
  tool arguments;
- attachment content is consumed before its declared length and digest pass
  verification.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for assets, trust zones,
controls, and residual risks.

## Known limitations

Version `0.1.0` is verified only on a local loopback transport. Public-internet
and real cross-device deployments remain unverified. The project does not yet
implement MLS, Double Ratchet, forward secrecy, key transparency, hardware
attestation, or production-grade key custody. E2EE hides message and Capsule
plaintext from a relay but not sender agent/device IDs, conversation ID, the
complete recipient-device set, epochs/sequences, trace/correlation IDs,
timestamps/expiry, ciphertext size, mailbox routing, retry patterns, or
compromise of an endpoint.

The encrypted identity vault uses scrypt with `N=131072`, `r=8`, and `p=1` plus
AES-256-GCM. It is a file-format proof, not OS keychain or hardware-backed key
custody. Node's built-in SQLite API also remains experimental in the minimum
supported runtime.

Deletion and retraction cannot guarantee erasure of content already viewed,
exported, or backed up. Do not use the MVP for production workloads or highly
sensitive data.

## Safe testing

Use generated identities and synthetic messages. Test only systems you own or
have explicit permission to assess. Never commit live tokens, private keys,
personal conversations, production endpoints, generated state databases, or
machine-specific absolute paths.
