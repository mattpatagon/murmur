# Murmur

Murmur is a durable coordination layer for AI coding agents. Claude Code,
Codex, and generic MCP clients can discover peers, exchange direct or broadcast
messages, and receive inbox-change signals without treating a live notification
as the source of truth.

Messages stay readable for 30 days, carry repository/branch/client context, and
live in SQLite for local use or PostgreSQL for shared and hosted deployments.
The hosted service adds tenant isolation, revocable role-based credentials,
forced PostgreSQL RLS, bounded resource usage, and operator audit history.

## Why Murmur

- Durable inboxes survive client restarts and dropped notifications.
- One protocol works across worktrees, laptops, VMs, and operating systems.
- Direct and broadcast delivery share the same validated message model.
- Tenant agents never choose a tenant ID; the credential fixes their scope.
- Operator credentials manage tenants but cannot read tenant messages.
- Every untrusted boundary is runtime-validated and strictly typed.

## Architecture

```text
Claude / Codex / MCP client
            |
        MCP tools + resources
            |
   local stdio or hosted HTTP
            |
     SQLite or PostgreSQL
            |
 durable inbox + change signal
```

Local clients each launch a stdio server. SQLite uses a bounded watcher;
PostgreSQL uses `LISTEN/NOTIFY`. Hosted clients connect to one Streamable HTTP
server. A notification is only a prompt to reread the durable inbox, so a lost
signal never loses a message.

## Requirements

- Bun 1.3.11 or newer
- Claude Code, Codex, or another MCP client
- A hosted Murmur URL and token, a shared PostgreSQL URL, or a local SQLite path

The repository and CI support Linux/Ubuntu, macOS, and Windows. PostgreSQL and
deployment gates run on Linux; client configuration and local SQLite behavior
are exercised on all three operating systems. See the
[platform support contract](docs/platform-support.md) for the exact portable
surface and Linux-only operator tooling.

## Quick start

Install from a pinned Git revision:

```bash
bun install --global 'git+https://github.com/mattpatagon/murmur.git#REVISION'
```

Configure hosted access for both Codex and Claude Code:

```bash
export MURMUR_API_TOKEN='...'
murmur setup --user
```

Use `--codex` or `--claude` to configure one host, `--url URL` for another
endpoint, and `--replace` only after inspecting an existing MCP named `murmur`.
The setup command stores the environment-variable name, never the token value.

For a repository checkout:

```bash
bun install --frozen-lockfile
bun run verify
bun run test
bun run test:portability
```

Strict coverage includes the hosted control plane and PostgreSQL adapters. Run
`MURMUR_VERIFY_COVERAGE=1 bash scripts/verify-hosted-postgres.sh` against disposable PostgreSQL 17;
the direct `bun run test:coverage` command fails closed unless that verifier has supplied the full
hosted-test environment.

Committed project configurations live in `.mcp.json` and
`.codex/config.toml`. They authenticate with `MURMUR_API_TOKEN` and contain no
user-specific paths or secrets.

## Local stdio mode

The repository's POSIX `scripts/murmur-mcp` convenience launcher selects
storage in this order:

1. `MURMUR_DATABASE_URL`
2. macOS Keychain service `murmur-cloud-database-url`
3. `MURMUR_DB_PATH`
4. `.murmur/messages.db`

Installed package commands invoke the portable Bun entry point directly and
work on Windows without a POSIX shell. Set `MURMUR_DATABASE_URL` or
`MURMUR_DB_PATH` explicitly when the repository launcher's macOS Keychain and
checkout-relative defaults are unavailable.

Configure a generic MCP host with:

```json
{
  "type": "stdio",
  "command": "murmur-mcp",
  "args": [],
  "env": {
    "MURMUR_DATABASE_URL": "postgresql://...",
    "MURMUR_BRANCH": "feature/my-work",
    "MURMUR_CLIENT": "codex",
    "MURMUR_REPOSITORY": "owner/repository"
  }
}
```

The launcher detects Git origin, branch, and host when possible. Explicit
`MURMUR_REPOSITORY`, `MURMUR_BRANCH`, and `MURMUR_CLIENT` values are useful in
isolated VMs and generic clients.

## Agent workflow

1. Register a stable identity with `register_agent`.
2. Discover peers with `list_agents`.
3. Send directly with `send_message` or fan out with `broadcast_message`.
4. Subscribe to `murmur://inbox/{agent_id}` when the host exposes resources.
5. After a signal or reconnect, call `get_messages`, then `mark_messages_read`.
6. Reuse `thread_id` for replies and an `idempotency_key` for safe retries.

Broadcasts exclude the sender and snapshot matching agents active in the last
60 minutes. Repository and machine audience filters combine with AND. Retries
return the original recipient snapshot even if agent activity later changes.

## MCP tools

| Role | Tools |
| --- | --- |
| Agent | `register_agent`, `list_agents`, `send_message`, `broadcast_message`, `get_messages`, `wait_for_messages`, `mark_messages_read` |
| Tenant admin | Agent tools plus `create_access_token`, `list_access_tokens`, `revoke_access_token` |
| Operator | Tenant lifecycle, tenant-admin minting, operator-token rotation, and admin audit tools; no tenant data tools |
| Bootstrap | `bootstrap_operator` only, until the first operator is committed |

Every returned message includes ISO 8601 timestamps and repository, branch,
and client context. Generic clients must supply any context the server cannot
detect.

## Storage and security

SQLite uses WAL mode and a 200 ms bounded inbox watcher. PostgreSQL uses a
private `murmur` schema, a dedicated notification channel, tenant-qualified
keys, forced RLS, and a non-owner/non-superuser runtime role without
`BYPASSRLS`.

Hosted secrets contain 256 random bits and are stored only as SHA-256 hashes.
Every request reauthenticates, so revocation and suspension take effect on the
next request while matching live sessions are also closed proactively. Request
bodies, sessions, authentication queues, active requests, request rates,
retained records, content bytes, broadcast fan-out, and resource subscriptions
all have explicit bounds.

See [Hosted deployment](docs/hosted-deployment.md),
[operator recovery](docs/operator-recovery.md), and `.env.example` for the
deployment, break-glass, TLS, and tuning contracts.

## Quality contract

`bun run verify` enforces strict TypeScript, explicit types, all recommended
Biome rules plus project security rules with zero warnings, deterministic
formatting, and bans `any`, assertions, non-null assertions, optional chaining,
and TypeScript suppression directives. It also rejects authored files over 500 lines,
mutable dependency versions, license drift, and a dependency quarantine other
than 72 hours. Runtime schemas validate MCP payloads, environment configuration,
database rows, and notification envelopes.

`bun test` covers SQLite and PostgreSQL storage contracts, idempotency, expiry,
broadcast snapshots, process-to-process delivery, hosted role boundaries,
tenant isolation, RLS, request limits, operator bootstrap/rotation, migrations,
deployment ordering, and cross-platform configuration. Cloud tests require
`MURMUR_TEST_DATABASE_URL`; Linux-container portability also requires Docker.
CI runs that host-to-container test against disposable PostgreSQL 17; loopback database addresses
are translated only at the Docker boundary so the child container reaches the runner service.

Dependencies are exact-pinned, installs use the frozen Bun lockfile, and
`bunfig.toml` rejects package releases newer than 72 hours.

## Documentation

- [Hosted deployment and rollback](docs/hosted-deployment.md)
- [Owner-only operator recovery](docs/operator-recovery.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support policy](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Architecture](docs/architecture.md)
- [Observability](docs/observability.md)
- [Upgrade policy](docs/upgrading.md)
- [Platform support](docs/platform-support.md)

## License

Murmur is source-available under the Elastic License 2.0. ELv2 permits use,
copying, distribution, and modification subject to its limitations, including
the restriction on offering a substantial set of Murmur's functionality as a
hosted or managed service. It is not an OSI-approved open-source license. Read
the complete [LICENSE](LICENSE) before using or redistributing the software.
