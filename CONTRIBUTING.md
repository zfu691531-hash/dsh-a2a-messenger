# Contributing

Thanks for helping improve DSH A2A Messenger. The project welcomes focused bug
reports, tests, documentation corrections, protocol review, and small changes
that preserve its security boundaries.

## Before contributing

- Read [ARCHITECTURE.md](ARCHITECTURE.md),
  [docs/PROTOCOL.md](docs/PROTOCOL.md), and
  [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- For a protocol or trust-boundary change, open a design discussion first and
  add or update an ADR. Product extensions must not be represented as standard
  Linux Foundation A2A fields.
- Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.
- Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development setup

Node.js 22.13 or newer is required so `node:sqlite` is available without an
experimental runtime flag.

```sh
npm run install:local
dsh-a2a doctor
npm test
npm run release:check
```

To remove the development link:

```sh
npm run uninstall:local
```

The local demonstration is available through `dsh-a2a demo`. It validates only
the loopback transport; do not describe it as public-internet or real-device
validation.

## Change guidelines

- Keep transport implementations behind the public Transport contract.
- Keep memory, audio, gesture, and same-device collaboration integrations behind
  versioned adapter/capability interfaces; never depend on their internal state.
- Treat all remote content as untrusted data. A valid signature authenticates a
  sender, not the safety of its instructions.
- Preserve deny-by-default tool authorization and the separation between a
  message, a capability proposal, local policy, human approval, and execution.
- Preserve immutable retry frames and transactionally durable deduplication.
- Never log message bodies, capsule bodies, decrypted keys, credentials, tokens,
  or human approval secrets.
- Add automated tests for observable behavior, especially replay, restart,
  revocation, epoch, approval, and quarantine rules.
- Avoid new runtime dependencies unless the security, maintenance, and license
  tradeoff is documented.

## Pull requests

Keep each pull request narrowly scoped. Explain the user-visible behavior,
security impact, compatibility impact, tests run, and any known limitation. A
protocol-breaking change requires a new version/extension URI and migration
notes. Update `CHANGELOG.md` for user-visible changes.

Before requesting review, run:

```sh
npm test
npm run release:check
```

Do not commit secrets, generated key material, local databases, real chat data,
coverage output, dependency caches, or personal absolute paths. Maintainers may
ask for a smaller patch or additional threat-model evidence before merging.
