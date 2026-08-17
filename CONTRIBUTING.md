# Contributing

Thanks for helping improve DSH A2A Messenger — a DSH plugin anchored on
cross-device agent communication and collaboration.

## Development setup

Node.js 22 or newer.

```sh
npm install
npm test
```

Tests run against the bundled mock relay (`test/mock-teammcp-server.mjs`);
no real server is needed. `npm run mock-server` starts the mock on :3100
for manual experiments.

## Change guidelines

- Preserve the quarantine boundary: incoming message content must never
  become model-visible without an explicit user command. Tools may expose
  metadata (sender, channel, count) only.
- Treat all remote content as untrusted data; keep the provenance header and
  the non-instruction caution in injected context.
- Keep the relay client defensive: normalize response shapes, never assume
  fields beyond what the mock server encodes.
- Never log message bodies, tokens, or credentials.
- Add or update tests for observable behavior, especially delivery, offline
  recovery, dedup, and quarantine transitions.
- Avoid new runtime dependencies unless the tradeoff is documented.

## Pull requests

Keep each pull request narrowly scoped. Explain the user-visible behavior,
the security impact, and the tests run. Update `CHANGELOG.md` for
user-visible changes. Do not commit secrets, local inbox files, or personal
absolute paths.
