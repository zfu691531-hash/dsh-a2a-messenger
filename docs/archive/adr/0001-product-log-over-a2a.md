# ADR 0001: Product log is the messaging truth source

- Status: accepted
- Date: 2026-08-16

## Decision

`dsh-a2a-messenger` owns its durable encrypted message log, outbox, inbox,
delivery cursor, replay set, group-control log, and task approval log. A2A is an
interoperability adapter for Agent Card discovery and Message/Task/Artifact
mapping; an A2A Message is never the messenger's truth source.

The normative interoperability baseline is A2A protocol `1.0`. The reviewed
specification patch is v1.0.1 (2026-05-26); patch numbers do not participate in
wire negotiation. Every A2A HTTP request must carry `A2A-Version: 1.0`.

## Why

A2A v1.0 section 3.3 makes Send Message idempotency optional. Section 3.7 says
Messages are not a reliable delivery mechanism for critical information and
that reconnecting clients may miss status messages. The Messenger therefore
cannot inherit offline delivery, deduplication, or recovery guarantees from
A2A.

## Consequences

- The MVP has its own transport-neutral encrypted envelope and append-only
  control events.
- A2A mapping is isolated in `src/a2a.mjs`.
- Messenger-only data uses versioned extension URIs; it is never presented as a
  standard A2A field.
- Standard task output maps to Artifact, while chat delivery remains a product
  operation.
