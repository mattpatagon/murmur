# TODOS

## Storage

### Make SQLite idempotent sends atomic across processes

**What:** Replace the SQLite check-then-insert path with an atomic conflict-aware insert and winner lookup.

**Why:** Two local MCP processes can race on the same idempotency key and expose a unique-constraint error instead of a duplicate result.

**Context:** Mirror the `ON CONFLICT DO NOTHING` flow in `PostgresMessageStore.sendMessage`, then fetch and compare the stored message.

**Effort:** M
**Priority:** P1
**Depends on:** None

## Remote MCP

### Decide whether sender context should be attested

**What:** Decide whether HTTP session context must override or match tool-supplied repository, branch, and client values.

**Why:** Context is currently descriptive and self-asserted; a shared-token client can label itself as another supported client.

**Context:** The present behavior matches Murmur's documented trusted-team model. Tighten it if client identity becomes an authorization or audit signal.

**Effort:** S
**Priority:** P3
**Depends on:** Per-client authentication design

## Completed

- Expire abandoned HTTP sessions while preserving active SSE responses; bound global and
  per-tenant session capacity.

  **Completed:** v0.4.0.0 (2026-08-09)

- Bound HTTP request bodies and agent metadata size, nesting depth, and key count before
  persistence while tolerantly decoding historical rows.

  **Completed:** v0.4.0.0 (2026-08-09)
