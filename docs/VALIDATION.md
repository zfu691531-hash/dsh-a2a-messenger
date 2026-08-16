# Validation record for 0.1.0

Date: 2026-08-16

## Release scope

The release candidate is approved only as a single-machine loopback MVP for
evaluating protocol and security boundaries. Public relay deployment, physical
cross-device messaging, mobile clients, NAT traversal, and A2A wire conformance
were not tested and are not claimed.

## Automated evidence

The following passed on the declared minimum Node.js 22.13.0 runtime:

```sh
npx -y node@22.13.0 --test
npx -y node@22.13.0 src/cli.mjs doctor
npx -y node@22.13.0 src/cli.mjs demo
npx -y node@22.13.0 scripts/release-check.mjs
```

- Tests: 28 passed, 0 failed.
- Doctor: 5 checks passed.
- Demo: three-agent membership converged; offline work retried; removed members
  lacked future access; denied task failed; approved task completed once;
  Capsule remained quarantined; relay plaintext marker check was false.
- Release check: required files, runtime metadata, sensitive patterns, version,
  MIT license metadata, and dependency-license inventory passed.
- Runtime dependencies: zero third-party packages.

Install and uninstall scripts were also exercised locally, with doctor passing
through the installed `dsh-a2a` command and local user data left intact on
uninstall.

## Required scenario coverage

Tests cover two-agent direct chat, multi-agent group convergence, verified
invitation checkpoints, agent/device revocation and controller key rotation,
offline retry and expiry, duplicate delivery and replay, future-epoch recovery,
restart persistence, unauthorized capability rejection, policy recheck,
single-use human-approval tokens, sender removal before execution, crash
reconciliation without silent re-execution, malicious Capsule quarantine and
recipient isolation, attachment-reference bounds, audit privacy, and A2A mapper
version/extension separation.

## Review evidence

DeepSeek Harness was used with the `cordis` preset at three meaningful
checkpoints: architecture rebuttal, implementation review, and final validation
review. Its implementation review reproduced minimum-runtime, expired-outbox,
and crash-recovery defects. Those reproductions became named regression tests.
The final read-only review returned GO for this explicitly bounded loopback MVP.

A standard Codex Security scan of the pre-fix source reported 14 findings (4
high, 7 medium, 3 low). The fixes added pinned controller authority, durable
membership state, authenticated device rekeying, recipient-scoped Capsule key
wrapping, strict proposal/approval binding, conservative crash reconciliation,
resource bounds, fixed audit codes, and complete relay-metadata disclosure.
The finding dispositions were checked against source and regressions, but a
second full canonical post-fix scan was not run; this distinction must remain
visible.

## Residual risks and next gate

Before any public or real cross-device claim, the project needs production group
key management (preferably MLS or an equivalently reviewed design), contact/key
transparency, OS-backed key custody and approval UI, authenticated multi-tenant
relay isolation/rate limiting/backpressure, metadata minimization, retention and
compaction policy, attachment fetch isolation, official A2A SDK conformance
testing, and real-device/network fault testing.
