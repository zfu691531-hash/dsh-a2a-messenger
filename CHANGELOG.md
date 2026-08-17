# Changelog

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
