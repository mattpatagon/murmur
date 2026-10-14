# Owner capacity

The hosted founding tenant has protected capacity selected from its authenticated tenant ID,
`00000000-0000-4000-8000-000000000001`. Agent names, repositories, request headers, metadata, and
claimed subscription tiers cannot confer priority. The owner uses an ordinary tenant credential;
operator credentials cannot access tenant messages.

## HTTP admission

`MURMUR_OWNER_PRIORITY` accepts only `0` or `1` and defaults to disabled. Production deployment
sets it to `1`. Enabling it reserves one quarter of each configured global request, processing,
stream, authentication, pending-authentication, and session ceiling, rounded down with a minimum
of one slot. Ordinary traffic is admitted below the remaining global watermark. The owner can use
reserved and unused shared slots up to the existing physical ceiling.

Owner per-principal and per-tenant admission limits use that physical ceiling, allowing several
owner clients to share a credential without hitting the ordinary caller quota first. Authentication
still serializes each credential, and session construction reserves capacity before asynchronous
initialization. Owner principal and tenant rate windows both use
`MURMUR_TENANT_RATE_LIMIT_PER_MINUTE`; other principal windows retain
`MURMUR_RATE_LIMIT_PER_MINUTE`. Requests still validate credentials on every call.

Startup loads at most 1,000 admission keys for live founding credentials from a private database
function. These are double hashes, never credential material or authorization results. A bounded
refresh runs every minute and after credential mutations, so ordinary cache expiry and restarts
cannot remove owner admission priority. Refresh failure preserves trusted hints while every request
still revalidates revocation, expiry, and tenant status. Explicit invalid authentication removes its
hint. Shutdown cancels the refresh timer and bounds pending database cleanup.

Rate-window bookkeeping also reserves one quarter of its existing 65,536-entry ceiling for
authenticated owner identities. Existing windows retain their normal rate counts and expiry rules.

With default request and stream ceilings of 64, ordinary traffic cannot occupy the last 16 slots.
A configured physical ceiling of one reserves the sole slot for the owner. Request bytes,
materialization memory, rates, authentication deadlines, and response lifetimes remain bounded.
Releasing a response does not release unfinished processing work.

## Durable identities and storage

The founding tenant permits 10,000 open and 100,000 retained identities. Other hosted tenants keep
the 1,000-open and 10,000-retained quotas. PostgreSQL constraints and quota triggers enforce these
bounds. SQLite retains ordinary quotas; owner priority is a hosted service entitlement. Open
identities include inactive identities with expired leases. Existing dormant closure and retained
history rules continue to apply.

At the owner's open-identity ceiling, registration retires the oldest eligible identity and ends
its leases while preserving messages and generation. It skips live orchestrator bindings and busy
identity or lease locks, examining at most 16 candidates. A dormant identity can reconnect to its
existing history. The retained-identity and global-storage ceilings continue to apply.

At the owner's HTTP session ceiling, initialization replaces the oldest established session,
ordered by last activity and session ID. Transport closure precedes application cleanup; a pending
slot remains charged throughout cleanup and replacement. Cleanup waits at most five seconds and
retains its charge if cleanup has not settled. Authorization changes during cleanup invalidate the
new initialization. Older clients reconnect through ordinary MCP initialization.

At the stream ceiling, a valid owner GET for a session without an existing stream closes the oldest
standalone SSE connection, ordered by opening time and session ID. The session and durable inbox
remain available for reconnect. Admission waits up to one second for the old response's actual
capacity release, with at most 64 waiters. Cancellation removes the waiter. Duplicate GETs and
invalid session bindings cannot evict another stream. Unfinished handlers retain processing charges.

The migration adds protected owner settings and usage counters to `murmur.hosted_storage_budget`.
Ownership comes from actual retained rows, including ciphertext and sessions, rather than session
configuration or client metadata. Updates, deletes, truncation, rollback, and reconciliation keep
the counters exact.

The migration-owner-only `owner_reserve_enabled` setting protects 100,000 rows and 256 MiB by
default within the existing two-million-row and 4 GiB global limits. Other tenants cannot consume
that slice. Owner writes can use it and unused shared capacity, subject to remaining message,
content, feedback, and global quotas. Restrictive administrative audit headroom remains separate.
Runtime and tenant roles cannot change reserve settings or counters.

After migrations, production deployment enables the storage reserve with:

```bash
MURMUR_OWNER_ADMIN_DATABASE_URL="$DATABASE_URL" \
  bun run scripts/configure-owner-capacity.ts
```

Obtain `DATABASE_URL` through the approved migration-credential access path. The script accepts
it through the environment, validates TLS configuration, uses bounded database deadlines, verifies
the committed setting, and prints a fixed confirmation. Repeating it is safe. Keep this credential
out of worker and MCP client configurations.

Inspect policy through a migration-owner connection:

```sql
select owner_reserve_enabled, owner_reserved_rows, owner_reserved_bytes,
  owner_rows, owner_bytes, retained_rows, accounted_bytes, max_rows, max_bytes
from murmur.hosted_storage_budget where singleton_id = 1;
```

The migration initially leaves reserve admission disabled so deployments explicitly select the
policy. Enabling it when ordinary usage exceeds the watermark preserves all existing data and
rejects only growing ordinary writes until usage falls. Trigger readiness, forced RLS,
least-privilege runtime roles, and verified authentication remain required.

## Capacity incidents

Inspect active leases, inactive identities, token lifecycle timestamps, and service-scoped
authentication, stream, and request rejection logs before attributing saturation to hostile clients.
An open-agent quota error does not establish that 1,000 clients are connected. A client sharing
the owner credential has the same authenticated identity; separate revocable worker credentials
provide independent attribution and revocation.

Close verified completed identities using their exact current generation, preserving retained
history. Assess live sessions and unrelated identities separately. Verify registration, direct
delivery, and the durable inbox after recovery. Keep message bodies, raw session IDs, database URLs,
and credentials out of incident reports and logs.

Priority prevents other tenants from consuming protected owner capacity. Owner workloads can
still fill finite service or storage ceilings; infrastructure outages still require recovery.
Clients should honor retry responses with bounded backoff.
