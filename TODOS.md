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

### Expire abandoned HTTP sessions

**What:** Add an idle timeout and bounded capacity to the remote MCP session registry.

**Why:** Clients that disappear without closing can otherwise retain transports and applications indefinitely.

**Context:** Track session activity in `src/http-server.ts`, close idle sessions, and reject or evict safely at a documented capacity.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Bound request and agent metadata size

**What:** Enforce request-body, metadata size, and metadata-depth limits before persistence.

**Why:** A trusted-token client can currently grow memory, database storage, and `list_agents` responses with oversized metadata.

**Context:** Add a body-size guard in `src/http-server.ts` and bounded metadata validation in `src/domain/contracts.ts`.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Decide whether sender context should be attested

**What:** Decide whether HTTP session context must override or match tool-supplied repository, branch, and client values.

**Why:** Context is currently descriptive and self-asserted; a shared-token client can label itself as another supported client.

**Context:** The present behavior matches Murmur's documented trusted-team model. Tighten it if client identity becomes an authorization or audit signal.

**Effort:** S
**Priority:** P3
**Depends on:** Per-client authentication design

## Completed
