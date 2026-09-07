# Hosted authentication query bounds

Every hosted HTTP request still checks its credential against PostgreSQL. The in-memory admission
cache only prioritizes previously validated credentials; it never substitutes for authentication.
Revocation, expiry and tenant suspension remain authoritative on every database call.

`authenticate_principal(bytea)` returns zero or one principal. Bootstrap state has a singleton key;
operator and tenant credential hashes are unique; each successful intermediate branch returns
immediately. The final tenant join uses the tenant primary key. V2 and the machine-aware v3
enrichment join use a unique tenant/token identity, so each version returns zero or one row.

Migration `20260905060622_hosted_auth_single_principal_rows.sql` declares `ROWS 1` for its functions;
the later v3 definition retains that bound while adding the authenticated machine field. The
annotation does not add a result limit, alter privileges, change security-definer ownership or
volatility, cache authentication, or change token-use timestamps. Setting only the outer estimate
would leave its inner join misestimated.

With the default estimate of 1,000 principals, PostgreSQL can hash the entire access-token table
for the v2 join on every authentication call. In the disposable 25,000-account failed load, table
statistics recorded 122,498,457 sequential token-row reads and 4,899 token-table sequential scans,
alongside 4,896 bootstrap lookups. The corrected cardinality permits a bounded indexed identity
lookup instead. This removes that concrete account-count-dependent scan; it is not a guarantee
that every query or offered workload meets the latency threshold.

## Regression gate

`test/hosted-auth-query-plan.postgres.test.ts` creates 2,048 isolated tenant/token fixtures within
one transaction, updates planner statistics, and calls the security-definer function required by
the runtime as `murmur_app`. Transaction-local table statistics must show zero sequential token-row
reads across repeated successful authentication. A separate EXPLAIN of the enrichment query must
use an indexed lookup. Functional checks retain tenant identity, operator isolation,
invalid-credential rejection, and immediate suspension and token revocation behavior.

All fixture writes and accounting changes are rolled back, including on assertion failure. The
test takes shared accounting locks and runs ANALYZE, so it belongs only in the existing serial
disposable PostgreSQL budget gate:

```sh
MURMUR_TEST_STORAGE_BUDGET=1 bun test test/hosted-auth-query-plan.postgres.test.ts
```

Both hosted-test database URLs must be provisioned; `scripts/verify-hosted-postgres.sh` supplies
them and enables this test after hosted bootstrap. It stays disabled during the broad coverage
pass. Do not run it concurrently with other database work or against production. The unchanged
full 25,000-account workload and latency thresholds remain the final performance acceptance gate.
