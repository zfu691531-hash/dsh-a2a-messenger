# Changelog

## 0.4.0 — 2026-08-18

Zero-deployment pivot: no server required. Two peer transport modes, both
first-class, feeding the same quarantine inbox.

### Added

- **GitHub mailbox transport (default)**: a private team repository acts as
  the relay — channels are issues (`a2a: <name>`), messages are comments.
  Identity, access control (collaborators), offline storage, history, and a
  human-readable web UI come from GitHub. Polling with a persisted cursor;
  token auto-resolution (config → GITHUB_TOKEN/GH_TOKEN → `gh auth token`).
- **Direct P2P sessions**: `/a2a-connect` produces a compressed connect code
  carried over any chat app; `/a2a-join` answers and completes. Traffic flows
  machine-to-machine over an encrypted WebRTC data channel with no server;
  sessions are destroyed on close. WebRTC engine (`@roamhq/wrtc`) is an
  optional dependency — where it cannot install, only direct mode is off.
- New surface: `a2a_direct_send` tool; `/a2a-connect`, `/a2a-join`,
  `/a2a-disconnect` commands; `/a2a-status` reports both modes.
- `Transport` interface; the TeamMCP relay is now one pluggable transport
  (`transport: 'teammcp'`), demoted to an optional low-latency mode.
- Tests: 29 total, including a mock GitHub API server and a real WebRTC
  loopback (offer/answer codes, bidirectional delivery, quarantine semantics).

### Changed

- Config schema reworked: `agentName` + `transport` selection; GitHub options
  (`githubRepo`, `githubToken`, `githubChannels`, `githubPollSeconds`);
  TeamMCP options (`serverUrl`, `token`) now optional.
- All incoming messages — mailbox or direct — go through the same quarantine
  inbox and human approval flow.

## 0.3.0 — 2026-08-17

Complete reorientation: from a standalone encrypted messaging CLI to a
DeepSeek Harness (DSH) plugin anchored on cross-device agent communication
and collaboration.

### Added

- DSH plugin entry (`dsh.bundle` + `cordis.patch.yml`): installable with
  `dsh plugin add github:zfu691531-hash/dsh-a2a-messenger`.
- Relay client for a self-hosted [TeamMCP](https://github.com/cookjohn/teammcp)
  server: send, channels, agents, offline inbox, ack, SSE live events with
  exponential-backoff reconnect and reconnect catch-up.
- Local quarantine inbox: incoming messages are persisted locally and are
  never model-visible until the user approves them; durable dedup by id;
  size and capacity limits.
- Model tools: `a2a_send`, `a2a_peers`, `a2a_inbox_status` (metadata only,
  content hidden).
- User commands (human-only, no model turn): `/a2a-status`, `/a2a-inbox`,
  `/a2a-accept <id|all>` (injects via `agent.inject()` with provenance and a
  non-instruction caution), `/a2a-reject <id|all>`.
- Mock TeamMCP relay + 18 automated tests covering delivery, offline
  recovery, dedup, quarantine transitions, and content-isolation guarantees.
- Server deployment guide: `docs/SETUP-SERVER.md`.

### Removed

- The 0.2.x standalone Node CLI (custom relay, E2EE envelope stack, key
  epochs, work packages) and all audio/gesture/memory adapter scope. The
  0.2.x protocol and threat-model documents are archived under
  `docs/archive/` as design input for the future public-community phase.

## 0.2.0 and earlier

See `docs/archive/` for the original standalone MVP documentation.
