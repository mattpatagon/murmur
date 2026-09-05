# Contributing to Murmur

Thank you for improving Murmur. The repository is source-available under the Elastic License 2.0;
by submitting a contribution, you agree that it may be distributed under those terms.

## Before starting

1. Read [AGENTS.md](AGENTS.md), [docs/architecture.md](docs/architecture.md), and
   [SECURITY.md](SECURITY.md).
2. Search existing issues and pull requests. Open an issue before a large protocol, schema,
   security-boundary, or compatibility change.
3. Coordinate overlapping work through Murmur. Name the branch, scope, dependencies, and owner of
   shared migrations, version changes, expensive gates, and deployment.
4. Never put tokens, database URLs, message bodies, tenant data, or production output in an issue,
   fixture, commit, or chat message.

## Development setup

Install Bun 1.3.14 or newer, Git, and the repository dependencies:

```bash
git clone https://github.com/mattpatagon/murmur.git
cd murmur
bun install --frozen-lockfile
bun run verify
bun run test
bun run test:portability
```

PostgreSQL integration work additionally needs Docker or a disposable PostgreSQL 17 instance. The
hosted verifier creates isolated roles and databases; never aim it at production.

## Commands

| Command | Contract |
| --- | --- |
| `bun run verify` | Strict types, zero-warning Biome, safety AST, 500-line, dependency, and format gates |
| `bun run test` | Environment-independent full suite; hosted and cross-machine cases report explicit skips when their external fixtures are absent |
| `bun run test:portability` | Platform-safe unit and integration suite used on Linux, macOS, and Windows |
| `bun run test:distribution` | Builds and installs the public tarball, then exercises all package commands without repository access |
| `bun run test:linux` | Required host-to-Linux-container MCP test; needs Docker and `MURMUR_TEST_DATABASE_URL` for disposable PostgreSQL 17 |
| `bun run test:coverage` | Strict coverage for an already-provisioned hosted-test environment; fails early instead of auditing skipped hosted code |
| `MURMUR_VERIFY_COVERAGE=1 bash scripts/verify-hosted-postgres.sh` | Authoritative PostgreSQL 17, RLS, upgrade, and hosted coverage gate |
| `bun scripts/verify-hosted-load.ts` | Coordinated, explicitly disposable local PostgreSQL workload; defaults to 25,000 registered tenants with bounded concurrency |
| `bun run build` | Bundles the stdio MCP entry point |
| `bun run build:http` | Bundles the hosted HTTP entry point |
| `bun run format` | Applies deterministic Biome formatting |

The full hosted test needs an isolated database administrator URL as documented by the script. CI
supplies it through a disposable PostgreSQL service, then runs the Linux-container test against the
same service. Environment-backed tests may skip in `bun run test`; that does not replace either
required CI result.

The [hosted load guide](docs/hosted-load-verification.md) defines separate fixture credentials,
admission/retry accounting, latency and RSS thresholds, and cleanup. Reserve the host's load and
database resources through Murmur first. Never run this workload against production; a passing
contributor suite or a smaller population does not establish the full workload result.

## Change design

- Keep modules focused and authored files at or below 500 lines.
- Add runtime validation at every new input boundary and exhaustive handling for every result.
- Preserve the durable-inbox, tenant-isolation, least-privilege, bounded-resource, and safe-error
  invariants in [AGENTS.md](AGENTS.md).
- Add tests before or with implementation. A regression test must fail on the old behavior.
- Use platform APIs for paths and processes. Do not add a POSIX dependency to package entry points.
- Add forward-only migrations; never edit an already-shared migration.
- Update docs and `.env.example` with every user- or operator-visible change.

## Pull requests

Keep each pull request reviewable and single-purpose. The description should include:

- the problem and user-visible outcome;
- architecture, data-flow, trust-boundary, or migration changes;
- failure behavior and rollback or recovery plan;
- tests and exact commands run;
- coverage impact;
- platform impact;
- dependency and license impact;
- observability and redaction impact.

Resolve all CI failures without weakening a gate. If a test is flaky, fix the determinism problem;
do not add retries or sleeps without a documented bounded failure model. Maintainers may ask for a
smaller change, additional threat modeling, populated upgrade evidence, or a fresh CI run after an
earlier merge.

## Review and release

Maintainers own merge order, version assignment, and production deployment. Do not bump a version
or trigger a deployment unless ownership is explicit. A release changes `VERSION`, `package.json`,
and `CHANGELOG.md` together and follows [docs/upgrading.md](docs/upgrading.md). Production is
healthy only after deployment, `/health`, and the authenticated smoke workflow all succeed.
