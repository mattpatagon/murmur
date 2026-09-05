# Hosted retained-storage budget

Hosted PostgreSQL admits retained data against a fixed database-wide budget shared by every
tenant and application replica. A new account does not increase the budget. When capacity is
full, growing writes fail; reads, acknowledgements, deletions and bounded lifecycle state changes
remain available. This is an admission policy, not a promise that every offered workload fits.

| Resource | Default limit | Relationship |
| --- | --- | --- |
| Retained data | 2,000,000 rows and 4 GiB accounted bytes | Shared across tenants |
| Feedback | 50,000 rows and 128 MiB accounted bytes | Also consumes retained-data allowance |
| Administrative audit | 100,000 rows and 64 MiB accounted bytes | Independent hard cap; final quarter reserved for restrictions |

Per-tenant quotas still apply. The global budget can reject a tenant before its individual quota is
full. The defaults provide about 168 KiB of accounted retained data per account across 25,000
accounts if usage were evenly distributed. They do not reserve an equal share per account, prevent
Sybil accounts from competing for capacity, or establish a concurrency or latency guarantee.

## Accounting contract

Every retained row is charged 512 bytes plus the UTF-8 serialized size of its variable string and
JSON fields, including field names. The fixed allowance prepays numbers, booleans, nullable
timestamps and bounded lifecycle enums, so acknowledgement, token revocation, tenant suspension,
session ending and encryption cancellation do not require additional space. Notice resolver and
withdrawer identities also use that fixed allowance; an optional resolution note consumes variable
bytes. These accounted bytes are deliberately distinct from PostgreSQL physical disk usage.

Excluded timestamp fields have PostgreSQL timestamp types. Excluded state, role, authority, client,
kind and lifecycle-reason strings have closed SQL CHECK allowlists in their owning tables.
`notices_actor_id_format` bounds resolver/withdrawer IDs to 200 ASCII characters, and notices permit
only one terminal state. These SQL constraints, rather than client validation, justify precharging
those fields. Nested metadata is always measured in full, even when its keys use the same names.

Accounting covers tenants, agent identities and sessions, access and operator tokens, messages,
broadcasts, notices, policies, feedback, control-plane state, tenant counters and all E2E tables.
Agent metadata, public bundles, certificates, claims, requests, envelopes and sender chains count
their actual serialized bytes. A client's ciphertext-length field cannot reduce that charge.
Internal usage counters do not determine the global count: consumed claims, retired prekeys and
committed or cancelled staging rows continue to count until their rows are deleted. An encrypted
broadcast commit stores both staging and committed copies and reserves both.

Statement triggers aggregate INSERT, UPDATE and DELETE changes. A guarded singleton-row update
serializes admission with concurrent transactions and rolls back with the write. Empty statements
and exact retries that insert nothing do not consume capacity. Owner TRUNCATE operations release
the measured removed rows; runtime credentials have no TRUNCATE permission. Negative accounting
or missing state fails closed instead of silently clamping counters.

Counter-only updates to `tenant_resource_usage` avoid recalculating an unchanged storage charge.
The accounting trigger checks the actual catalog on each call: `tenant_id` must remain a non-null
UUID, and every other live column must have a built-in smallint, integer or bigint type. Each row
then costs exactly 559 accounted bytes, including its UUID; UPDATE preserves the number of rows.
Nullable integer counters are safe because both numbers and null use the fixed allowance. Any
other column type or a nullable tenant ID falls back to the complete old/new accounting path.
INSERT and DELETE accounting, quota admission, and mixed-statement trigger ordering are unchanged.
The agent/token quota functions remain database-trigger-only: callers cannot execute or attach
them to their own tables, but normal runtime writes still invoke the existing triggers.

The singleton lock lasts until its transaction ends. Long transactions can delay another tenant's
write, and rejected transactions can still generate temporary data and WAL. Runtime statement,
lock and idle-transaction deadlines limit waiting. Load verification must measure this contention
at the configured request admission and database pool sizes before increasing them.

The caller receives `Hosted storage capacity reached. Retry after retained data has been cleaned
up.` Self-service registration maps the same condition to its existing capacity response, HTTP 503
with Retry-After. The application never returns budget contents, SQL text or raw database details.

## Owner operations

`murmur.hosted_storage_budget` and its accounting/reconciliation functions are private, use forced
RLS and grant no access to the runtime, public, anonymous or authenticated roles. Only the migration
owner can inspect or change them. Operator and tenant MCP tools cannot increase the limits.
The sole exception is `hosted_storage_budget_ready()`, which grants the runtime a boolean readiness
probe without exposing usage or limits. Hosted startup and PostgreSQL message-store initialization
require its success. Missing tables, disabled or replaced triggers, incorrect transition tables and
new unaccounted durable tables make readiness fail closed.

Read counters and limits using the migration credential through the existing protected database
workflow. Do not place that credential in a command, repository or log. The following SQL contains
no credentials:

```sql
select retained_rows, accounted_bytes, feedback_rows, feedback_bytes, audit_rows, audit_bytes,
  max_rows, max_bytes, max_feedback_rows, max_feedback_bytes, max_audit_rows, max_audit_bytes
from murmur.hosted_storage_budget where singleton_id = 1;
```

Capacity tuning is an explicit owner decision, independent of signup count. For example, restoring
the documented defaults uses:

```sql
update murmur.hosted_storage_budget
set max_rows = 2000000, max_bytes = 4294967296,
    max_feedback_rows = 50000, max_feedback_bytes = 134217728,
    max_audit_rows = 100000, max_audit_bytes = 67108864
where singleton_id = 1;
```

Lowering a limit below current usage does not delete data or change its counters. Operations that
increase the affected resource remain rejected until usage falls below the configured limit.
Non-growing operations and deletes remain admitted. Never manually zero or decrement counters to
recover capacity; they must continue to describe the retained rows.

Audit admission reserves the final quarter of both absolute audit limits for the trusted restrictive
actions `tenant.suspend` and `operator_token.revoke`. At the defaults, ordinary audit writers stop at
75,000 rows or 48 MiB; the remaining 25,000 rows and 16 MiB are protected headroom, not extra capacity.
An owner-configured limit reserves `max(1, floor(limit / 4))` units, so even a limit of one is never
raised. Existing usage above the ordinary watermark is preserved and blocks ordinary growth.

Only INSERT statements containing exclusively those two fixed actions may use the headroom.
Mixed statements and audit UPDATE growth remain ordinary. Runtime credentials cannot write audit
rows directly or call the private accounting helper; the existing security-definer control-plane
functions choose the action, never caller input. The singleton lock makes classification and
admission atomic with each required audit write. Ordinary signup and administration cannot consume
the protected quarter, including when unrelated retained data is already full.

The absolute audit limits still apply to restrictions. At a full hard cap, suspension and operator
revocation fail atomically; neither the action nor its mandatory audit event is committed. Repeated
restrictions can exhaust the reserve, so this is bounded emergency capacity, not guaranteed unlimited
administration. Tenant-admin access-token revocation has no audit insertion and remains non-growing.
No audit history is skipped or automatically deleted. Monitor both watermarks and arrange explicit
owner-authorized export and bounded deletion before capacity fills. Feedback remains append-only
for runtime callers; any owner export or deletion needs its own explicit retention decision.

Expiry alone does not release budget. Existing bounded pruning must actually delete expired rows,
including those belonging to inactive tenants. Aggregate admission prevents unbounded retained
growth but does not provide a database-wide scheduler or guarantee timely recovery of stale space.

## Migration and reconciliation

The forward migrations `20260904235120_hosted_storage_budget.sql` and
`20260904235238_hosted_storage_budget_enforcement.sql` install private accounting and backfill
actual retained data before enabling enforcement. The backfill takes write-blocking locks on all
accounted tables in a stable order within the same transaction as trigger installation. A five-second
lock deadline and five-minute statement deadline make failure explicit; a failed enforcement
migration rolls back and must be retried in a drained maintenance window.

`20260905053627_hosted_audit_restrictive_headroom.sql` adds the protected audit watermark without
rewriting data, changing counters or limits, replacing triggers, or broadening runtime privileges.
Existing accounting function identities remain stable, including the startup readiness contract.

Backfill preserves existing data even when its measured usage exceeds the configured limits. It
does not silently expand limits, evict data or reinterpret live-only E2E counters as retained rows.
The owner can repeat reconciliation during a drained maintenance window:

```sql
begin;
set local statement_timeout = '5min';
select murmur.reconcile_hosted_storage_budget();
commit;
```

Reconciliation takes the same table locks and leaves limits unchanged. Compare observed counters
before and after; unexpected drift is an incident to investigate, not routine expected behavior.
New durable tables or changes to field bounds must update the closed accounting table list and its
tests in the same migration. Existing deployed migration files remain immutable.

## Verification and physical limits

With the disposable hosted PostgreSQL environment provisioned, the serial gate is:

```sh
MURMUR_TEST_STORAGE_BUDGET=1 bun test \
  test/hosted-storage-budget.postgres.test.ts \
  test/hosted-storage-budget-e2ee.postgres.test.ts \
  test/hosted-audit-headroom.postgres.test.ts
```

It changes global limits temporarily and must not overlap other database tests or run against a
shared or production database. Tests cover competing tenants, exact boundaries, rollback, UTF-8,
full-capacity acknowledgement/suspension, audit exhaustion, feedback retries, E2E retained states
and duplicate ciphertext copies, cascades, owner backfill, corruption rejection and direct privileges.
Headroom tests fill the ordinary row and byte watermarks, require real ordinary control-plane calls
to fail, then verify audited suspension and operator revocation succeed within unchanged hard caps.
They also reject mixed-action batches, forged runtime audit writes/private-helper calls, and
restrictions at the absolute cap, with rollback and counter reconciliation throughout.
`scripts/verify-hosted-postgres.sh` runs this serial suite after hosted bootstrap in both ordinary
and coverage modes. During the broad coverage run the global-mutation tests stay disabled; the
following dedicated invocation explicitly enables every budget test. Requesting the budget gate
without both database URLs is an error, never a successful skipped run.

Logical admission cannot cap physical database usage or a provider invoice. PostgreSQL indexes,
TOAST, dead tuples, vacuum work, WAL, replication, backups and failed transactions consume resources
outside this metric. Disk monitoring, physical headroom, bounded hosting replica/pool settings and
provider-side cost controls remain required. Fixed logical limits imply rejection under excess
demand; they cannot promise unchanged service capacity as usage grows.
