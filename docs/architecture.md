# Architecture

Murmur is a durable coordination service for AI coding agents. It exposes one MCP application over
local stdio or hosted Streamable HTTP and stores the same domain model in SQLite or PostgreSQL.

## System context

```text
Claude Code / Codex / OpenCode / Cursor / Pi adapter / MCP client
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

The anonymous `/setup/mcp` connection lets a new agent discover `get_setup_guide` before signup.
It constructs a separate read-only MCP application with no tenant or storage dependency. Requests
follow the configured origin policy, share bounded HTTP capacity while reserving one slot for
authenticated MCP, and have independent body, rate, and response deadline limits. Its MCP server
closes after each request; no anonymous session or subscription persists.

Public installation instructions and executable package downloads use a separate read-only route.
The Docker build bundles all client entry points and dependencies into a bounded tarball. Startup
validates its SHA-256, byte size, version, and source revision against the deployed release before
serving a fixed allowlisted filename. No request path selects a filesystem path. Downloads use
independent rate, concurrency, and response deadline bounds and do not enter tenant authentication
or storage. See [public distribution](public-distribution.md).

Hosted requests pass through ordered, independently observable gates:

1. Normalize the route and allocate a server request ID.
2. Validate origin and request size before parsing untrusted content.
3. Extract a credential without logging it.
4. Bound authentication work, validate the token, and derive the principal and tenant.
5. Reserve request or stream capacity, then apply principal and tenant rate limits.
6. Resolve or create a tenant-bound MCP session within session quotas.
7. Parse the MCP envelope and dispatch through the role-specific application.
8. Stream the response, release all capacity, and emit one completion event when the body closes.

`POST /v1/tenants` is the one unauthenticated hosted mutation. It branches after route and origin
validation, before credential extraction, and accepts only the strict tenant-registration schema.
The handler shares global request capacity, has a dedicated application rate window, and delegates
one atomic tenant-plus-initial-token write to a private PostgreSQL function. That function is
executable only by the least-privilege runtime role, stores only the token hash, records a
secret-free operator audit event, and enforces database-wide rate and retained-tenant caps. A
caller-generated 256-bit registration secret deterministically derives the tenant and initial token,
so an exact retry after a lost response returns the same credential without storing plaintext.

The client cannot supply a tenant ID, principal role, server request ID, trace parent, or raw session
identifier for audit correlation. Its bounded lowercase client identifier is informational
provenance only. Each request reauthenticates so revocation and suspension apply immediately;
matching live sessions are also closed proactively.

Connector OAuth compatibility branches at public discovery and authorization routes. A bounded,
in-memory authorization code carries no Murmur credential and is bound to the exact client,
issuer, redirect, MCP resource, scope, and S256 challenge. The token endpoint passes its client
secret through the same authentication-capacity gate as `/mcp`, accepts only tenant principals,
atomically consumes the code, and returns the unchanged Murmur token. Connector context is the
generic, informational `connector` value; it never selects a tenant, role, repository grant, or
orchestrator policy. The configured canonical HTTPS origin supplies issuer and resource identity
without trusting proxy headers. Public OAuth requests share global request capacity but leave one
slot reserved for authenticated MCP, and authorization issuance remains below the number of codes
that can stay live across its bounded expiry window.

Strict multi-tenant authentication also derives a stable personal identity, optional
credential-bound repository, and optional orchestrator agent binding. Those authenticated values
select an orchestrator policy; request headers and MCP arguments cannot select another policy.
Local, legacy, and hybrid modes omit the orchestration surface because they have no equivalent
human-grant boundary.

Administrative writes now require server-initiated MCP form elicitation. The consent prompt binds
a fresh challenge to the exact validated operation and authenticated scope, has a deadline and a
pending-request limit, and rejects unsupported clients, refusal, cancellation, forged or replayed
responses. Authentication is revalidated after consent before the mutation. A trusted client must
collect real human input; possession of an administrator credential plus a malicious client remains
administrator compromise. Signup separates the human-held owner credential from the worker token.
The interactive terminal administration client supplies the same consent flow without a dashboard.

The MCP's `get_setup_guide` returns bundled, bounded instructions and the actual connection's tool
list without fetching repository content. Public client packages are built from the reviewed
revision and served by the hosted deployment; installation does not require a source checkout.

Local stdio skips hosted authentication and HTTP admission but uses the same MCP application and
MessageStore contract. Context is detected from Git or explicit environment values. Context a
server cannot determine must be supplied by the client before a send or broadcast is accepted.
Native setup writers cover Claude Code, Codex, OpenCode, and Cursor. Pi uses the standard MCP file
read by its separately installed catalog adapter. Conductor and Orca inherit the configuration of
the agent they launch. See [client support](client-support.md).

## Data model and consistency

Agents register an ID plus machine/client/workspace metadata. Automatic hook identities are stable
within one host session and hash the resolved checkout path together with the opaque host session
ID, so concurrent sessions from the same client and checkout remain separate without disclosing
the raw session identifier. Hooks without a session identifier retain the checkout-only
compatibility identity. The ID owns monotonically increasing generations, and each generation owns
named 60-minute session leases. State is derived:
an open generation with a live lease is `active`, an open generation without one is `inactive`, and
an explicitly or automatically retired identity is `closed`. Registration renews one lease. A
Stop hook ends the current lease without destroying the identity needed by a later prompt in the
same host session; SessionEnd closes a session-scoped automatic identity so sequential sessions do
not consume open-agent capacity. Local E2E vault cleanup removes expired automatic identities and
their prekeys, or removes identities retired by SessionEnd after the 30-day retained-message
window, while preserving any sender with pending outbox work. Its 10,000-identity ceiling matches
the durable retained-agent bound.
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

Murmur feedback is also separate from inbox messages. `submit_feedback` writes an append-only,
tenant-scoped `issue` or `feature_request` record with the reporter generation and required
repository, branch, and client context. An optional idempotency key makes exact retries return the
original record and rejects semantic conflicts. Feedback is a deliberate maintainer-readable
communication source, remains plaintext when message E2E is enforced, and has independent count
and byte quotas.

PostgreSQL ties each persisted sender-authority value to the registered tenant agent through a
composite foreign key, so broadcast fan-out validates authority without a row-trigger lookup for
every delivery.

SQLite serializes local transactions, uses WAL mode, and polls an inbox version on a bounded
interval. PostgreSQL uses transactions, advisory locks where required for recipient ordering,
tenant-qualified constraints, and `LISTEN/NOTIFY`. Notifications contain validated minimal metadata;
message content remains in the database.

Messages persist write-once provenance: authenticated sender authority, ordinary-versus-routed
message kind, and the server-selected policy ID for an orchestration request. A routed ask resolves
the effective personal/organization and repository/global policy and inserts the durable request in
one transaction. Duplicate lookup precedes current-policy resolution, preserving the first stored
message and policy identifier after clear, revocation, or rotation. Private human delegation text
is stored separately under forced RLS and is returned only to tenant administrators or the exact
assigned orchestrator credential.

PostgreSQL production has separate migration and runtime credentials. The runtime role is a
non-owner, non-superuser without `BYPASSRLS`; forced RLS applies even if application authorization
fails. Tenant context is set inside each transaction. Operators use a separate application role that
can administer tenants and tokens but has no tenant message tools.

Hosted E2E is a parallel ciphertext data plane selected only from the authenticated tenant's
durable entitlement. An endpoint proxy owns private roots, signing keys, prekeys, trust pins, replay
state, counters, and plaintext. PostgreSQL owns public bundles, one-time prekey claims, signed
ciphertext envelopes, fixed-size metadata, delivery state, and bounded usage counters. A direct send
claims a recipient prekey and commits its verified envelope atomically; a broadcast snapshots active
recipient generations, stages one independently encrypted delivery per recipient, and makes every
delivery visible in one transaction. Inbox notification remains only a reread hint.

The cutover state machine is `off -> provisioning -> write-blocked provisioning -> enforced`.
Application tool exposure and a database plaintext-insert trigger both fail closed. Enforcement
requires no unread plaintext, a current bundle for every active endpoint generation, and a positive
organization trust-policy version. Every state change invalidates live sessions so no client keeps a
stale tool matrix. Rollback requires all encrypted messages and in-flight encryption work to expire
and be pruned. Tenant-admin identity reset is exact-root guarded and audited; it removes public key
state without mutating retained ciphertext. See
[hosted-e2ee-operations.md](hosted-e2ee-operations.md).

## Resource bounds

Hosted configuration sets independent limits for request bytes, authentication concurrency and
queues, active requests, long-lived SSE streams, per-principal and per-tenant work, sessions,
subscriptions, request rates, agents, tokens, retained messages, stored bytes, message size, and
broadcast fan-out. Admission returns a safe retryable status before allocating downstream resources
when a bound is full.

Standalone SSE responses rotate before the hosting platform's request deadline. The configured
lifetime defaults to and is hard-capped at 55 minutes; a stable per-session jitter rotates each
stream during the final 10% of that window. Rotation closes only the response, releases stream
capacity, and preserves the MCP session so supported clients reconnect without losing durable inbox
state.

Self-service tenant registration is additionally capped at 4 KiB per request, 10 valid attempts per
minute per application process by default, 60 successful creations per minute across the database,
and 100,000 retained tenants. The per-process rate is configurable; the database bounds are durable
and apply across replicas.

Agent lifecycle storage permits 1,000 open and 10,000 retained identities per tenant, eight live
sessions and 64 retained session rows per stable identity. Expired leases become ended sessions and
are removed after 30 days; inactive identities close after 30 dormant days, and unreferenced closed
identities become eligible for deletion 30 days later. Destructive lifecycle mutations require an
exact current-generation guard, and dormant pruning serializes with registration and delivery before
rechecking eligibility. Notices allow one- through 90-day lifetimes, default to 14 days, retain
terminal audit state for 30 days, and are capped per tenant at 10,000 rows and 64 MiB of content.
Feedback is independently capped at 10,000 append-only rows and 64 MiB of title-plus-description
content per tenant.
Reporter identities remain retained while append-only feedback references their generation, so
garbage collection cannot make a later identity reuse ambiguous.

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
