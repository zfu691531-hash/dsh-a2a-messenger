# Validation record for 0.2.0

Date: 2026-08-17

## Release scope

The release candidate is approved only as a single-machine MVP using the
SQLite loopback Transport and an authenticated local HTTP+SQLite relay. Public
relay deployment, TLS termination, physical cross-device messaging, mobile
clients, NAT traversal, and A2A wire conformance were not tested and are not
claimed.

## Automated evidence

The following passed on both the local Node.js 26.5.0 runtime and the declared
minimum Node.js 22.13.0 runtime:

```sh
npm test
npx -y node@22.13.0 --test
npx -y node@22.13.0 src/cli.mjs doctor
npx -y node@22.13.0 src/cli.mjs work-demo
npx -y node@22.13.0 scripts/release-check.mjs
```

- Tests: 44 passed, 0 failed on each runtime.
- Doctor: 6 checks passed, including the envelope and Work Package schemas,
  SQLite, A2A version header, runtime version, and metadata-only audit shape.
- Work demo: a code directory traveled directly over authenticated local HTTP,
  was materialized after approval, and a result directory returned; the relay
  plaintext marker check was false.
- Release check: 20 required files, sensitive-pattern checks, version, MIT
  metadata, minimum runtime, and dependency-license inventory passed.
- Runtime dependencies: zero third-party packages.

The ordinary three-Agent demo also passed. Install, global `dsh-a2a version` and
`doctor`, and uninstall were exercised; uninstall left local user data intact.
`git diff --check` and `npm pack --dry-run --json` passed.

## Required scenario coverage

Tests cover two-Agent direct chat, multi-Agent group convergence, verified
invitation checkpoints, device revocation/rotation, offline retry and expiry,
duplicate delivery and replay, future-epoch recovery, endpoint restart,
unauthorized capability rejection, policy recheck, single-use human approval,
sender removal before execution, crash reconciliation without silent task
re-execution, malicious Capsule quarantine and recipient isolation, attachment
reference bounds, audit privacy, and A2A extension separation.

Work Package tests cover direct source/binary transfer and result return,
encrypted relay storage, human/policy approval, no-overwrite path validation,
corrupt chunks, sibling-device chunk injection, exact origin-device revocation,
offline retry, staging restart recovery, expiry/aggregate quota, HTTP mailbox
authentication, bounded pulls, active registered recipients, invalid example
credentials, and release exclusion of live credential files. Materialization
tests cover both crash windows: an atomically renamed exact result is verified
and completed after restart without another write; a pre-write crash becomes
`blocked`, cleans only package-scoped temporary directories, and succeeds only
through an explicit policy/device-authorized retry.

## Review evidence

DeepSeek Harness was used with the `cordis` preset in one continuous session at
three meaningful checkpoints: architecture rebuttal, implementation review,
and final validation review. Its implementation review reproduced sender
binding, policy coupling, HTTP expiry propagation, and package lifecycle gaps;
those became named regressions. Its final review then found one materialization
recovery dead end. After recovery/result-verification/retry tests were added,
DSH reran the original and adversarial probes and returned **GO** with no release
blocker.

A Codex Security working-tree diff scan reviewed all 12 changed executable
surfaces and sealed 8 low-severity findings. The release candidate closes them
with canonical timestamps, exact origin-device/key binding, chunk lifecycle
cleanup, registered Relay recipients, bounded HTTP pulls and durable quotas,
strict generated-token format, invalid public placeholders, and explicit live
credential release blocking. Focused malicious and legitimate-path regressions
pass; the canonical scan remains a pre-fix snapshot rather than a claim that
the original snapshot had no findings.

## Residual risks and next gate

Recovery is exposed as an explicit API; an integrator must invoke it for known
`materializing` packages during startup. Until it does, the package and staged
chunks are intentionally retained as reconciliation evidence rather than
silently deleted or re-executed. The relay also needs operator cleanup after
durable row quotas are reached.

Before any public or real cross-device claim, the project needs production
group key management (preferably MLS or an equivalently reviewed design),
contact/key transparency, OS-backed key custody and approval UI, authenticated
multi-tenant relay isolation/rate limiting/retention, attachment fetch
isolation, official A2A SDK conformance testing, and real-device/network fault
testing.
