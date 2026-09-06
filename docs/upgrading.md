# Upgrade policy

Upgrades are deliberate, exact-pinned, independently reviewable changes. Murmur does not accept
dependency ranges or packages published in the previous 72 hours.

## Installed Murmur upgrades

Call the read-only MCP tool `check_for_upgrades` with an empty object from a standard Murmur
connection or the local E2E proxy. It compares the running endpoint's four-part version with the
latest official hosted release metadata and returns:

- `status` as `update_available`, `up_to_date`, or `ahead`, plus `update_available` for callers that
  only need a boolean;
- the current and latest versions, exact 40-character `latest_revision`, and `checked_at` time;
- three brief `upgrade_steps` covering a revision-pinned global install, configuration refresh,
  and host restart.

The check never installs or changes configuration. Its fixed upstream request has a five-second
deadline, enforces response type and byte limits, validates every returned field, deduplicates
concurrent calls, caches a successful result for five minutes, and observes a 30-second failure
cooldown. A failed or malformed upstream response returns a fixed safe error instead of repository
or transport details. Production sets
`MURMUR_RELEASE_REVISION` to the deployed 40-character source revision so `/version` publishes a
version and revision from the same release.

Follow the returned install command exactly. Then run `murmur setup --user`, or preserve encrypted
mode with `murmur setup --user --e2ee`, and restart active Codex and Claude sessions. Repository
checkouts should fetch and review the returned revision before updating their own pinned checkout.

Public packages use the hosted `/downloads/` endpoint and contain bundled clients and license
notices; installation does not require a Git checkout. Call `get_setup_guide`
after reconnecting for complete installation, hook, and feature instructions.

Administrative mutations now require form elicitation with explicit human consent. Keep an owner
connection separate from worker credentials, or use `murmur admin` in a private interactive
terminal. Unattended integrations must not silently approve arbitrary requests. The reviewed
bootstrap and production-canary scripts approve only the exact operation and complete arguments
already declared by their authorized verification plan, and reject altered or repeated prompts.

## Dependency upgrades

1. Read upstream release notes, migration notes, supported runtime matrix, license, provenance, and
   known security advisories.
2. Change one coherent dependency family at a time. Keep runtime and development dependencies
   separate and preserve exact semantic versions in `package.json` and `overrides`.
3. Run Bun's update/install command intentionally, review the complete `bun.lock` diff, and confirm
   every new transitive package has cleared `bunfig.toml`'s 259,200-second release-age quarantine.
4. Search for changed APIs, defaults, environment variables, generated output, and compatibility
   constraints. Update code and documentation explicitly; do not hide changes behind assertions.
5. Run `bun run verify`, `bun run test`, `bun run test:portability`, both builds, and the hosted
   PostgreSQL coverage gate for runtime, database, MCP, HTTP, or telemetry dependencies. Direct
   `bun run test:coverage` is only valid after the hosted-test environment is provisioned.
6. Record user-visible or operational impact under `[Unreleased]` in `CHANGELOG.md`.

The dependency policy script rejects `^`, `~`, inequality ranges, tags, aliases, workspace links,
Git URLs, and other mutable direct references. CI installs only with `bun install --frozen-lockfile`.
The [hosted launch dependency record](hosted-launch-dependencies.md) documents the runtime's
current transitive overrides and their removal conditions.

Website dependency upgrades use `website/package.json`, `website/bun.lock`, and
`website/bunfig.toml` under the same exact-version and release-age policy. Install the website's
frozen dependencies before root verification, and run `website:check`, `website:build`, and
`website:test`. Refresh the third-party notices and browser evidence as described in
[website maintenance](website.md#verification-and-maintenance).

### Pinned SDK declaration correction

`@modelcontextprotocol/sdk@1.30.0` has a version-pinned Bun patch in `patches/`. Its
`StreamableHTTPClientTransport.sessionId` getter returns `string | undefined`, but the shared
`Transport` declaration omits explicit `undefined` from the optional property. The two ESM/CommonJS
declaration edits make that interface match the existing runtime behavior under
`exactOptionalPropertyTypes`. No JavaScript, dependency version, license (MIT), or runtime surface
changes; strict library checking remains enabled. The real production-observer SDK import and
reconnect test exercise this compatibility boundary.

The release maintainer owns the patch. Remove it, its manifest/lockfile mapping, and the Docker
patch-copy step when the pinned upstream SDK's unmodified declarations pass `bun run verify` and
the production-stream tests. Review the patch on every SDK upgrade; do not carry it to another
version automatically. CI and Docker must install it through the reviewed frozen lockfile.

### Pinned SDK declaration correction

`@modelcontextprotocol/sdk@1.30.0` has a version-pinned Bun patch in `patches/`. Its
`StreamableHTTPClientTransport.sessionId` getter returns `string | undefined`, but the shared
`Transport` declaration omits explicit `undefined` from the optional property. The two ESM/CommonJS
declaration edits make that interface match the existing runtime behavior under
`exactOptionalPropertyTypes`. No JavaScript, dependency version, license (MIT), or runtime surface
changes; strict library checking remains enabled. The real production-observer SDK import and
reconnect test exercise this compatibility boundary.

The release maintainer owns the patch. Remove it, its manifest/lockfile mapping, and the Docker
patch-copy step when the pinned upstream SDK's unmodified declarations pass `bun run verify` and
the production-stream tests. Review the patch on every SDK upgrade; do not carry it to another
version automatically. CI and Docker must install it through the reviewed frozen lockfile.

## Bun upgrades

Bun is both runtime and package manager. Update all reviewed pins together:

- `package.json` `packageManager`, `engines.bun`, and `test:linux`;
- `website/package.json` `packageManager` and `engines.bun`, matching the root pin;
- both `Dockerfile` stages;
- every workflow `bun-version`, including production smoke;
- README, contributor and hosted deployment requirements, launcher error text, tests, and this
  documentation where the minimum changes;
- the MCP installation guide, public `/install` instructions, and bundled package README.

Use the new runtime for `bun install --frozen-lockfile` and `bun run website:install` first.
A runtime-only upgrade should not change dependency selections; preserve both lockfiles unless
the new runtime requires a reviewed format update. Existing `@types/bun` versions need no change
when they already match the runtime.

Then verify install, typecheck, lint, formatting, portable tests, SQLite migrations, PostgreSQL
integration, bundled stdio/HTTP entry points, the Linux container test, and a clean package install.
Do not claim a platform is supported until its CI job passes with the new runtime.

The [HTTP transport contract](node-http-transport.md) relies on the pinned runtime's native drain
and disconnect behavior. Recheck its source assumptions, portable transport regressions, and the
bounded slow-reader memory gate on the release build before adopting another Bun revision.

## Schema and protocol upgrades

PostgreSQL migrations are immutable after reaching a shared environment. Add a timestamped forward
migration, make it safe to resume, and test both an empty database and a populated prior release.
Separate expand, compatibility, and contract phases when older writers may still receive traffic.
Never finalize a contract while an incompatible writer is live.

SQLite upgrades run transactionally and preserve user data. Test every supported predecessor and
the rejection of a database newer than the binary. Back up local database files before a manual
upgrade if their contents matter.

MCP changes are additive when possible. Preserve existing tool names, required fields, error
meanings, idempotency behavior, resource URIs, and message retention semantics. A breaking change
requires an explicit compatibility plan, versioned contract, migration path, and release note.

### v0.14 client and operator checklist

- Send one JSON-RPC message per authenticated HTTP POST. All arrays are rejected with HTTP 400,
  including batches from older negotiated MCP versions. Parallel individual POSTs remain supported.
- Keep each in-flight request ID unique within its session. Numeric `42` and string `"42"` remain
  distinct; duplicate active IDs receive HTTP 409. After cancellation before a response send, the
  affected session can be retired. On its subsequent 404, initialize a new session and restore
  subscriptions, then reread the durable inbox. See [request-ID admission](http-request-id-admission.md).
- Follow `next_cursor` on agent, notice and policy lists and `nextCursor` on `resources/list`, even
  when fewer items than requested arrive. For an oversized inbox, retry with a smaller `limit`
  (start with 1), then continue from the last returned sequence, never `inbox_version`. See
  [inbox response budgets](inbox-response-budget.md). No message is silently truncated or acknowledged.
- Parse successful tool text as JSON; its indentation is no longer stable. Check the MCP result
  even when HTTP returns 200: processing and materialization overload use retryable code `-32003`.
  Honor retry hints with bounded backoff and preserve write idempotency keys.
- Apply the [retained-storage and audit-headroom migrations](hosted-storage-budget.md) before the
  matching application. New startup requires accounting readiness. Existing data and hard limits
  are preserved; monitor the ordinary audit watermark before protected restriction capacity fills.
- Keep the container backend on HTTP/1 with `--no-use-http2`; public clients may still use HTTP/2
  at Cloud Run's frontend. Direct self-hosting needs the upstream protections in the
  [transport contract](node-http-transport.md).

Stdio does not inherit HTTP request-ID, processing or byte-admission policy, but storage page limits
and compact tool text apply to both transports. Legacy SQLite E2E fields above the new commit bounds
fail explicitly rather than being rewritten; see [broadcast compatibility](e2ee-broadcast-memory.md).

### Earlier compatibility contracts

The connector-client expansion adds replacement message, broadcast, and feedback check constraints
as `NOT VALID`, validates each table in its own bounded-lock migration, then swaps the validated
constraints into the stable names. Apply all five migrations in order. If validation reports its
five-second lock timeout, leave the recorded migrations and constraints unchanged and rerun the
same pending migration after the conflicting workload releases the table; do not drop or rename a
constraint manually.

The v0.6 lifecycle expansion backfills existing agents and messages into generation 1 and creates a
60-minute compatibility lease for agents seen during the preceding hour. Apply its migrations before
the matching application, complete traffic cutover and drain older writers before those leases can
expire, then verify lifecycle, history, and notice behavior through the hosted suite. Older writers
do not renew named leases, and a pre-v0.6 application must not be restored after any identity has
advanced beyond generation 1; use a forward fix instead.

The expansion separates column/constraint installation, constraint validation, backfill, trigger
installation, and concurrent index creation so production locks remain bounded. If a concurrent
index build is interrupted, rerun the unchanged migration: it removes only a same-named index marked
`INVALID` in `pg_index` before rebuilding it, while preserving a valid index. The hosted verifier
asserts that no lifecycle index remains invalid and exercises both empty and populated upgrades.

The orchestrator-authority expansion adds credential personal/repository identity, a distinct
bound token role, forced-RLS policies, message provenance, and `authenticate_principal_v2`. Apply
all three forward migrations before starting this application revision. The v1 authentication
function remains unchanged for deployment skew, while this revision probes and consumes v2.
Populated upgrades backfill existing credentials and messages to personal IDs and peer provenance.
Do not edit those backfills or promote an existing peer agent row to orchestrator authority.

Finish rolling this application revision to every replica before creating the first orchestrator
token or policy. The schema expansion alone remains compatible with the previous binary, but
orchestration data does not: the previous authentication parser rejects the new role and its token
cleanup may be blocked by retained policy attribution. After orchestration data exists, rollback is
supported only to this release or a later schema-compatible binary, optionally running in hybrid
mode. Do not mint during a mixed-version rollout.

Hook/server skew is additive across this rollout. This server returns the legacy message shape to
the released `murmur-hook` 0.1.0 client, while the new hook accepts both legacy messages and the new
provenance fields. Complete the server rollout before relying on provenance-aware hook guidance.

An application capability rollback may use hybrid mode, which authenticates retained database
credentials but exposes no orchestration tools. It does not reverse the schema or erase provenance.
After returning to strict multi-tenant mode, verify policy assignments because revoked tokens stay
inactive until a tenant administrator rotates and reapplies them.

## Release and rollback

A release owner updates `VERSION`, `package.json`, and `CHANGELOG.md` in one commit after all prior
merges. The clean revision must pass CI before it reaches `main`. Production deployment follows
[hosted-deployment.md](hosted-deployment.md), including preflight, migrations, traffic cutover,
health, and authenticated smoke verification.

Website publication and rollback follow [website operations](website.md); its separate Pages
workflow verifies the public Git revision, response headers, routes, and 404 after upload.

Application rollback is allowed only to a revision compatible with the current database contract
and enabled secret versions. Database contract migrations are forward-only; recovery uses a fixed
forward revision, not an edited migration or destructive rollback.
