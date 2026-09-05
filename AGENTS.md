# Murmur agent guide

This file is the repository-level operating contract for coding agents. It applies to every file
in this repository. Human instructions, security policy, and production safety take precedence.

## Agent behavior

- Infer routine intent and scope from the request and prior conversation, then carry the requested
  work through to completion. Treat requests such as "can you," "help me," and "I want to" as
  authorization to act within the stated scope and begin the work.
- Make reasonable, reversible assumptions when details are missing. Ask a focused question only
  when the answer could materially change the result. Complete already-authorized work first so
  any approval request concerns a concrete, reviewable result.
- Incorporate new user instructions while work is in progress. Preserve compatible completed work
  and change course when the new instruction supersedes it.
- User instructions take precedence over skill guidelines. Security policy, production safety, and
  this repository contract still apply. If a skill makes the agent pause, request permission, or
  diverge from the user's intent, identify the exact `SKILL.md` and relevant instruction, then
  distinguish that requirement from the agent's interpretation.
- Use subagents when independent work can run in parallel and delegation would save time or improve
  quality. Keep delegated scopes distinct, coordinate shared resources through Murmur, and make
  inter-agent messages legible with normal spacing.
- Lead with the outcome. Use concise paragraphs and plain language, and introduce technical detail
  only when it helps the reader. Use lists for genuinely parallel or sequential information and
  avoid unnecessary nested structure.
- Avoid canned phrases such as "Bottom Line," "delve," "foster," "leverage," "it's worth noting,"
  "importantly," "in short," and "the simplest mental model." State the intended action directly
  and avoid contrastive framing that introduces an alternative the user did not ask about.
- Calibrate verification to the change while completing every required gate. Do not add tests for
  reversible, low-impact documentation or configuration changes that do not fix a bug when those
  tests would merely mirror the change. After appropriate checks pass, repeat or broaden them only
  when a new change, failure, or unresolved risk warrants it.

## Product invariants

- The durable inbox is authoritative. Notifications only tell clients to reread it.
- A hosted tenant is derived from a validated credential, never from client input.
- Operator credentials may administer tenants but may not read or mutate tenant messages.
- Every external value is validated at its boundary: MCP payloads, HTTP metadata, environment
  configuration, database rows, notification envelopes, and subprocess output.
- Authentication, requests, sessions, subscriptions, retained data, content bytes, and broadcast
  fan-out remain explicitly bounded.
- Errors are safe for the caller and useful for the operator. Never expose credentials, database
  URLs, message bodies, raw session IDs, SQL text, or internal exception messages.
- SQLite and PostgreSQL behavior must remain semantically equivalent unless a documented hosted
  security boundary requires a difference.
- Linux, macOS, and Windows are supported. Do not introduce a shell-only path into a portable
  package entry point or test gate.

## Required quality gates

Run `bun run verify` before requesting review. It enforces:

- strict TypeScript for runtime, scripts, and tests;
- all recommended Biome rules, project-specific security rules, and zero warnings;
- explicit variable, parameter, property, return, and catch-variable types;
- no `any`, type assertions, non-null assertions, optional chaining, or TypeScript suppression
  comments;
- a maximum of 500 lines for every authored text file, with hash-pinned exceptions only for
  immutable generated or already-deployed artifacts;
- exact dependency versions, the ELv2 package identifier, an exact Bun toolchain pin, and Bun's
  72-hour minimum dependency release age;
- deterministic formatting.

Run `bun run test` for the environment-independent contributor suite. Strict coverage includes the
hosted control plane and PostgreSQL adapters, so `bun run test:coverage` deliberately refuses to run
without its provisioned hosted-test environment. The authoritative gate is
`MURMUR_VERIFY_COVERAGE=1 bash scripts/verify-hosted-postgres.sh`; every metric must exceed 90%,
every included source file's line coverage must exceed 80%, and no source file may disappear from
the report.
Run `bun run test:portability` when changing paths, configuration, storage, entry points, or HTTP
behavior. Run `bun run test:linux` with disposable PostgreSQL when changing packaging, Docker, or
cross-process database behavior; CI must execute this host-to-container gate without skips. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the complete command table.

Never weaken a threshold, exclusion, rule, or pinned exception to make a change pass. Fix the
implementation or add meaningful tests. Any unavoidable exception needs a narrow scope, a reason,
an owner, and a deterministic removal condition.

## Repository map

- `src/domain/`: branded value objects, data contracts, and protocol models.
- `src/e2ee/`: canonical encryption, endpoint vaults, trust, proxy flows, and public wire contracts.
- `src/mcp/`: MCP application composition, tools, resources, and safe result mapping.
- `src/storage/`: SQLite/PostgreSQL adapters, transactions, rows, and migrations.
- `src/hosted/`: multi-tenant authentication, authorization, quotas, and control plane.
- `src/http/`: request parsing, admission, routing, response lifecycle, and sessions.
- `src/observability/`: structured logs, request correlation, deadlines, and OpenTelemetry.
- `scripts/`: deterministic validation, deployment, migration, recovery, and smoke gates.
- `test/`: unit, contract, integration, upgrade, security, and portability tests.
- `website/`: static Astro pages, React interactions, styles, and isolated website tooling.
- `supabase/migrations/`: immutable, ordered PostgreSQL migrations.
- `docs/`: architecture, operations, observability, platform, and upgrade contracts.

Read [docs/architecture.md](docs/architecture.md) before changing data flow or trust boundaries.

## Implementation rules

- Prefer small modules with one reason to change. Split a file before it approaches 500 lines.
- Model invalid states out of the type system with branded values and discriminated unions.
- Narrow `unknown` explicitly. Use Zod at untrusted runtime boundaries.
- Do not use `as`, angle-bracket assertions, `!`, optional chaining, `any`, or TypeScript suppression
  directives. A narrow `biome-ignore` is allowed only for a demonstrated false positive and must
  state why the flagged value is safe.
- Keep side effects at composition boundaries. Pass clocks, stores, transports, log sinks, and
  capacity policies into logic that must be deterministic in tests.
- Use absolute deadlines for potentially blocking work. Bound queues and cleanup operations.
- Preserve stable ordering for results, diagnostics, migrations, and tests.
- Do not catch an error unless you add context, translate it to a safe domain result, continue a
  documented cleanup sequence, or terminate with a nonzero status.
- Catch variables are `unknown`. Public failures use allowlisted error classes or fixed messages;
  operational details belong in redacted structured fields.
- Cleanup is idempotent. On partial startup failure, close acquired resources in reverse order and
  continue remaining cleanup if one close fails.
- Never log or trace request bodies, message content, authorization headers, token material,
  database URLs, raw session IDs, or arbitrary exception text.
- Comments explain why a constraint exists, not what obvious code does.

## Storage and migrations

- PostgreSQL queries execute through the least-privilege runtime role with forced RLS.
- Set and verify tenant context inside the transaction that uses it.
- Maintain tenant qualification for identities, sequence numbers, idempotency keys, broadcasts,
  sessions, and usage accounting.
- Use parameterized queries. Identifiers must come from closed, reviewed sets.
- Never edit a migration that has reached any shared environment. Add a new forward migration.
- Exercise upgrades from populated prior schemas and direct RLS access, not only empty databases.
- SQLite migrations are transactional and reject schema versions newer than the binary supports.

## Tests

- Every bug fix includes a failing regression test that proves the unsafe or incorrect behavior.
- Test success, invalid input, boundary values, saturation, cancellation, cleanup, and redaction.
- Use in-memory SQLite for deterministic unit contracts and disposable PostgreSQL 17 for RLS,
  concurrency, notification, and migration behavior.
- Do not depend on test order, wall-clock sleeps, public services, a developer home directory, or
  machine-specific paths.
- Use temporary directories and injected clocks/IDs where practical. Clean up processes, servers,
  sockets, databases, and credentials in `finally` blocks.
- A skipped environment integration test is not coverage evidence. CI's hosted database gate is
  authoritative.

## Dependencies and upgrades

- Direct dependencies, development dependencies, and overrides use exact semantic versions.
- Install with `bun install --frozen-lockfile` outside an intentional upgrade.
- Do not add a package for behavior that the runtime or a small local module provides clearly.
- Document a new dependency's purpose, runtime surface, license, maintenance state, and removal
  cost in the pull request.
- Keep production dependencies separate from test/build tooling.
- Follow [docs/upgrading.md](docs/upgrading.md); update every Bun pin in one change.

## Documentation and platform support

- A changed command, environment variable, error, field, limit, protocol, migration, or operator
  action requires documentation in the same change.
- Keep README examples secret-free and location-independent.
- Use `node:path`, URL APIs, and platform helpers instead of concatenating separators.
- Portable TypeScript entry points must work on Windows without `sh`. POSIX scripts are reserved
  for Linux deployment gates or clearly labeled conveniences.
- Update [docs/platform-support.md](docs/platform-support.md) when support or CI scope changes.

## Coordination and release safety

- Before overlapping work, use Murmur to register, list active agents, and read pending messages.
- Share scope, branch or PR, dependencies, urgency, and expensive shared resources. Assign one
  owner for version bumps, migrations, merge order, deployment, and production verification.
- Do not run competing database, browser, build, or coverage jobs on the same constrained host.
- Recheck the inbox before merge. Announce status or priority changes and close the thread when
  work is done. Never send secrets through Murmur.
- Preserve unrelated working-tree changes. Do not rewrite shared history or bypass protected gates.
- Releases update `VERSION`, `package.json`, and `CHANGELOG.md` together, then pass clean-checkout
  CI before merge. Deployment and production smoke verification have one explicit owner.

## Review checklist

- Trust boundaries and authorization are explicit.
- Resource use and latency are bounded.
- Failure and cleanup paths are tested.
- Logs and traces are correlated, low-cardinality where practical, and redacted.
- Coverage and portability tests exercise the changed behavior.
- No authored file exceeds 500 lines.
- Dependencies, documentation, migrations, and compatibility contracts are current.
