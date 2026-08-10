# Upgrade policy

Upgrades are deliberate, exact-pinned, independently reviewable changes. Murmur does not accept
dependency ranges or packages published in the previous 72 hours.

## Dependency upgrades

1. Read upstream release notes, migration notes, supported runtime matrix, license, provenance, and
   known security advisories.
2. Change one coherent dependency family at a time. Keep runtime and development dependencies
   separate and preserve exact semantic versions in `package.json` and `overrides`.
3. Run Bun's update/install command intentionally, review the complete `bun.lock` diff, and confirm
   every new transitive package has cleared `bunfig.toml`'s 259,200-second release-age quarantine.
4. Search for changed APIs, defaults, environment variables, generated output, and compatibility
   constraints. Update code and documentation explicitly; do not hide changes behind assertions.
5. Run `bun run verify`, `bun run test:portability`, `bun run test:coverage`, both builds, and the
   hosted PostgreSQL gate for runtime, database, MCP, HTTP, or telemetry dependencies.
6. Record user-visible or operational impact under `[Unreleased]` in `CHANGELOG.md`.

The dependency policy script rejects `^`, `~`, inequality ranges, tags, aliases, workspace links,
Git URLs, and other mutable direct references. CI installs only with `bun install --frozen-lockfile`.

## Bun upgrades

Bun is both runtime and package manager. Update all reviewed pins together:

- `package.json` `packageManager`, `engines.bun`, and `test:linux`;
- both `Dockerfile` stages;
- every workflow `bun-version`;
- README, hosted deployment requirements, launcher error text, tests, and this documentation where
  the minimum changes.

Then verify install, typecheck, lint, formatting, portable tests, SQLite migrations, PostgreSQL
integration, bundled stdio/HTTP entry points, the Linux container test, and a clean package install.
Do not claim a platform is supported until its CI job passes with the new runtime.

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

## Release and rollback

A release owner updates `VERSION`, `package.json`, and `CHANGELOG.md` in one commit after all prior
merges. The clean revision must pass CI before it reaches `main`. Production deployment follows
[hosted-deployment.md](hosted-deployment.md), including preflight, migrations, traffic cutover,
health, and authenticated smoke verification.

Application rollback is allowed only to a revision compatible with the current database contract
and enabled secret versions. Database contract migrations are forward-only; recovery uses a fixed
forward revision, not an edited migration or destructive rollback.
