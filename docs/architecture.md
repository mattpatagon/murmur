# Architecture

Murmur is a durable coordination service for AI coding agents. It exposes one MCP application over
local stdio or hosted Streamable HTTP and stores the same domain model in SQLite or PostgreSQL.

## System context

```text
Claude / Codex / generic MCP client
                 |
       stdio or HTTPS + MCP
                 |
      validation and admission
                 |
     authenticated MCP application
                 |
       MessageStore contract
          /             \
 local SQLite       hosted PostgreSQL
 bounded poller       LISTEN / NOTIFY
```

The durable inbox is the source of truth. Resource notifications and wait completion are hints to
reread it, never message delivery themselves. A dropped or duplicated notification therefore does
not lose or duplicate a durable message.

## Module boundaries

| Area | Responsibility | Must not own |
| --- | --- | --- |
| `domain` | Branded values, commands, records, protocol contracts | I/O, SQL, HTTP |
| `storage` | MessageStore adapters, transactions, migrations, row validation | MCP or HTTP policy |
| `hosted` | Credential verification, roles, tenants, quotas, control plane | Transport rendering |
| `mcp` | Tool/resource schemas, authorization surface, safe results | Raw SQL or HTTP admission |
| `http` | Origins, credentials, capacity, rate limits, sessions, routing | Tenant selection from input |
| `observability` | Correlation, structured events, traces, redaction | Request bodies or secrets |
| entry points | Composition, lifecycle, signals, startup/shutdown | Domain rules |

Dependencies point inward toward domain contracts. Adapters implement interfaces; they do not leak
database clients, HTTP types, or vendor errors into the application.

## Request flow

Hosted requests pass through ordered, independently observable gates:

1. Normalize the route and allocate a server request ID.
2. Validate origin and request size before parsing untrusted content.
3. Extract a credential without logging it.
4. Bound authentication work, validate the token, and derive the principal and tenant.
5. Reserve request or stream capacity, then apply principal and tenant rate limits.
6. Resolve or create a tenant-bound MCP session within session quotas.
7. Parse the MCP envelope and dispatch through the role-specific application.
8. Stream the response, release all capacity, and emit one completion event when the body closes.

The client cannot supply a tenant ID, principal role, server request ID, trace parent, or raw session
identifier for audit correlation. Each request reauthenticates so revocation and suspension apply
immediately; matching live sessions are also closed proactively.

Local stdio skips hosted authentication and HTTP admission but uses the same MCP application and
MessageStore contract. Context is detected from Git or explicit environment values. Context a
server cannot determine must be supplied by the client before a send or broadcast is accepted.

## Data model and consistency

Agents register a stable ID plus machine/client/workspace metadata. Direct sends and broadcasts
create independent recipient records with tenant-qualified sequence numbers. Thread IDs preserve a
conversation; idempotency keys make safe retries return the original result, including a broadcast's
original recipient snapshot.

SQLite serializes local transactions, uses WAL mode, and polls an inbox version on a bounded
interval. PostgreSQL uses transactions, advisory locks where required for recipient ordering,
tenant-qualified constraints, and `LISTEN/NOTIFY`. Notifications contain validated minimal metadata;
message content remains in the database.

PostgreSQL production has separate migration and runtime credentials. The runtime role is a
non-owner, non-superuser without `BYPASSRLS`; forced RLS applies even if application authorization
fails. Tenant context is set inside each transaction. Operators use a separate application role that
can administer tenants and tokens but has no tenant message tools.

## Resource bounds

Hosted configuration sets independent limits for request bytes, authentication concurrency and
queues, active requests, long-lived SSE streams, per-principal and per-tenant work, sessions,
subscriptions, request rates, agents, tokens, retained messages, stored bytes, message size, and
broadcast fan-out. Admission returns a safe retryable status before allocating downstream resources
when a bound is full.

Queues are finite and waits have deadlines. Shutdown stops new admission, closes the HTTP server,
closes applications and stores, then flushes telemetry within a bounded timeout. Cleanup remains
best-effort across multiple failures and preserves the original startup or shutdown error safely.

## Failure model

- Invalid external input becomes a stable client-safe MCP or HTTP error.
- Authentication backend failure is distinct from an invalid or missing credential.
- Capacity and rate rejection are distinct by gate and scope.
- Database rows and notification envelopes are parsed before use; malformed trusted-state data
  fails closed.
- Full response-body lifecycle, not merely handler return, controls capacity release and completion
  logging.
- Unknown exceptions are reduced to allowlisted classes for logs and fixed messages for callers.
- Telemetry is optional; invalid enabled configuration fails startup, exporter failure cannot expose
  request data, and shutdown is time-bounded.

## Evolution

Protocol additions start in domain schemas, then update both stores, MCP tools/resources, transport
tests, documentation, and compatibility tests. PostgreSQL migrations are forward-only and verified
from populated previous states. SQLite rejects a database schema newer than the running binary.
See [upgrading.md](upgrading.md) and [hosted-deployment.md](hosted-deployment.md).
