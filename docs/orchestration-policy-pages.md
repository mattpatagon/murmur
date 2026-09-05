# Orchestration policy pages

Hosted `list_orchestrator_policies` returns a fitting prefix bounded by both the requested
count (1–100) and an 8 MiB accounted response budget. Its output fields are unchanged.
Continue using `next_cursor` until it is null, even when a page contains fewer than `limit`
policies. No instructions are truncated and no policy is deleted.

## Accounting and admission

Each row costs `13 × UTF-8 instruction bytes + 8 KiB`. A control character can consume six
JSON bytes in structured content and seven in the separately escaped tool-text copy.
The fixed allowance covers the SQL-bounded IDs, agent/repository fields, timestamps, JSON
field names, cursor, envelope and the bounded overflow-row metadata. It is conservative
accounting, not a physical heap measurement. All non-instruction string fields are bounded
by UUID types, SQL checks or existing runtime value-object validation.

With 8,192 instruction bytes per row, a page fits 73 policies. A count-only page of 100 valid
policies with control-character instructions and maximum-length agent/repository fields
would produce 10,881,930 tool-response bytes. The regression calculates that exactly one
row at a time, checked against a small serialized response, without allocating that entire
oversized wire representation.

The function reserves 8 MiB from the existing shared materialization scope before opening
the database transaction. Saturation rejects immediately without any SQL. After the query,
row validation and transaction complete, it shrinks the reservation to the returned rows'
accounted cost. Empty results release it; query, validation and transaction failures release
it. Nonempty results retain their reservation through the existing outer-handler and HTTP
response lifecycle. Storage-only callers still enforce the page cap without a hosted scope.

## Query and cursor contract

A single PostgreSQL statement takes a payload-free `limit + 1` candidate snapshot containing
IDs, ordering fields and instruction byte costs. Materialized window accounting selects
the fitting IDs before full policy/token payloads are joined. Overflow rows carry IDs,
positions and null payloads; their instructions never cross the database driver boundary.
The parser checks contiguous positions, unique IDs, payload identities, cumulative byte
costs and a gap-free fitting prefix before returning any policies.

Ordering remains `(scope_kind, scope_owner_id, repository_name, policy_id)`. The cursor is
still the last returned policy UUID, looked up within the same tenant using the existing
tuple comparison. Missing, foreign-tenant and end cursors return empty pages. Disabled
policies and policies whose tokens are revoked remain listed, as before. Each page has one
statement snapshot; concurrent changes between successive pages retain the existing cursor
semantics and are not a stable multi-request export snapshot.

Tenant context, forced RLS, runtime-role privileges and tenant-qualified token joins are
unchanged. No migrations, grants or security-definer functions are added. The implementation
uses PostgreSQL 17's explicit [CTE materialization](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION)
and retains the existing [RLS boundary](https://supabase.com/docs/guides/database/postgres/row-level-security).

The focused unit regression and `test/orchestration-policy-page.postgres.test.ts` cover
accounting, fitting-only raw payload transfer, tenant isolation, tied ordering prefixes,
cursor draining, empty cursors, saturation and failure recovery. The PostgreSQL suite requires
the disposable hosted-test environment; skipped tests are not database verification evidence.
This page cap does not establish a process-wide memory ceiling or latency guarantee.
