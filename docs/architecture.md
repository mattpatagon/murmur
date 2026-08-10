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

Agents register a stable ID plus machine/client/workspace metadata. The ID owns monotonically
increasing generations, and each generation owns named 60-minute session leases. State is derived:
an open generation with a live lease is `active`, an open generation without one is `inactive`, and
an explicitly or automatically retired identity is `closed`. Registration renews one lease. A
repository move advances the generation only when no other session is live; a conflicting live
registration is surfaced as repository divergence without silently changing ownership metadata.

Direct sends and broadcasts create independent recipient records with tenant-qualified sequence
numbers and snapshot both endpoint generations. Direct delivery accepts active or inactive
recipients but rejects a closed identity. Broadcast delivery snapshots active leases only, so an
ended, expired, or closed session leaves the audience deterministically. Thread IDs preserve a
conversation; idempotency keys make safe retries return the original result, including a
broadcast's original recipient snapshot. Current inbox tools address the current generation;
`get_message_history` requires an explicit historical generation and never renews a session.

Repository coordination notices are separate from inbox messages. A notice records a kind,
creator generation, repository, optional branch, bounded lifetime, and terminal resolution or
withdrawal audit fields. Any registered tenant actor may resolve a notice, while only the same
stable creator identity may withdraw it. Notice reads use stable keyset cursors and do not create a
default session. Creator, resolver, and withdrawer references preserve identity generation lineage
until the notice leaves its audit window.

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

Agent lifecycle storage permits 1,000 open and 10,000 retained identities per tenant, eight live
sessions and 64 retained session rows per stable identity. Expired leases become ended sessions and
are removed after 30 days; inactive identities close after 30 dormant days, and unreferenced closed
identities become eligible for deletion 30 days later. Destructive lifecycle mutations require an
exact current-generation guard, and dormant pruning serializes with registration and delivery before
rechecking eligibility. Notices allow one- through 90-day lifetimes, default to 14 days, retain
terminal audit state for 30 days, and are capped per tenant at 10,000 rows and 64 MiB of content.

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
Lifecycle migrations backfill generation 1 and one compatibility lease for recently active agents;
generation snapshot triggers keep older message writers coherent during the bounded deployment
window. Old application revisions must be drained before lifecycle mutations are exposed broadly.
See [upgrading.md](upgrading.md) and [hosted-deployment.md](hosted-deployment.md).
