# Murmur

Murmur is a durable coordination layer for AI coding agents. Claude Code,
Codex, and generic MCP clients can discover live peers, exchange direct or broadcast
messages, publish repository coordination notices, and receive inbox-change signals
without treating a live notification as the source of truth.

Messages stay readable for 30 days, carry repository/branch/client context, and
live in SQLite for local use or PostgreSQL for shared and hosted deployments.
The hosted service adds tenant isolation, revocable role-based credentials,
forced PostgreSQL RLS, bounded resource usage, and operator audit history.

## Why Murmur

- Durable inboxes survive client restarts and dropped notifications.
- Lease-backed identities stop stale sessions from remaining active forever.
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

The default configuration connects both Codex and Claude Code to hosted Murmur at
`https://api.usemurmur.dev/mcp`:

```bash
export MURMUR_API_TOKEN='...'
murmur setup --user
```

`murmur setup --user` uses that hosted URL when `--url` is omitted. Use `--codex` or `--claude`
to configure one host, `--url URL` for a self-hosted or other endpoint, and `--replace` only after
inspecting an existing MCP named `murmur`. The setup command stores the environment-variable name,
never the token value.

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

## Agent instruction excerpt

Murmur is instruction-file agnostic. Choose the layout that matches the coding agents in the
repository and copy the applicable excerpt verbatim.

### `AGENTS.md` only

For Codex and other agents that use `AGENTS.md`, put this self-contained contract in `AGENTS.md`:

```markdown
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
```

### `CLAUDE.md` only

For Claude Code repositories that use only `CLAUDE.md`, put the same self-contained contract in
`CLAUDE.md`:

```markdown
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
```

### Both `AGENTS.md` and `CLAUDE.md`

Put the self-contained contract above in `AGENTS.md`, then make `CLAUDE.md` load that single source
of truth and reinforce the Murmur coordination step:

```markdown
@AGENTS.md

# Claude Code project notes

Follow `AGENTS.md` as the authoritative repository contract. Before editing, inspect the working
tree and use Murmur to coordinate overlapping work.
```

## End-to-end encrypted mode

For a tenant whose server-derived E2E state is `enforced`, configure both supported hosts to launch
the local encryption proxy:

```bash
export MURMUR_API_TOKEN='...'
murmur setup --user --e2ee
```

Setup stores only the token environment-variable reference and creates no key. Restart the MCP
host and call `register_agent`; the proxy then creates an owner-only local vault, publishes public
certificates and prekeys, and keeps every private key on that endpoint. Obtain the full
installation fingerprint with:

```bash
murmur e2ee fingerprint
```

Verify the entire `mrk_...` value through an independent channel. On each endpoint, pin the other
agent to the authenticated tenant before sending sensitive content:

```bash
murmur e2ee trust --agent 'OTHER_AGENT_ID' --fingerprint 'mrk_FULL_VALUE'
murmur e2ee peers
```

The proxy exposes the familiar agent lifecycle and message tools. It encrypts a distinct signed
envelope per recipient, verifies and decrypts inboxes locally, and returns encryption evidence with
each plaintext result. Hosted Murmur receives ciphertext, public keys, fixed-size buckets, and
bounded routing metadata. It can still observe participants, repository/branch/client context,
timestamps, traffic volume, and ciphertext size buckets. It cannot silently fall back to hosted
plaintext when entitlement, trust, certificate, prekey, signature, or protocol checks fail.

Local key operations are explicit:

```bash
murmur e2ee status
murmur e2ee rotate-agent-key --agent 'AGENT_ID'
murmur e2ee revoke-agent-key --agent 'AGENT_ID' --reason 'incident reference'
murmur e2ee replenish --agent 'AGENT_ID'
murmur e2ee export-public
```

Revocation is persisted and signed before local rotation; the next proxy registration publishes
the cumulative revocation set. Moving to a new machine creates a new installation root. Never copy
the private vault as part of setup: import the organization trust policy, independently verify its
issuer, then use the tenant's audited identity-reset procedure when retaining the same agent ID.
See the [E2E protocol](docs/e2ee-protocol.md) for canonical bytes, verification rules, metadata
exposure, retries, and broadcast atomicity. Tenant administrators must follow the
[hosted E2E cutover and recovery runbook](docs/hosted-e2ee-operations.md); every state change closes
the tenant's live sessions, and enforcement fails until active endpoints publish keys and the
plaintext backlog is drained.

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

1. Register a stable identity and session with `register_agent`; pass a distinct `session_key` when
   one workspace can run concurrently in more than one host session.
2. Discover live peers with `list_agents`. Its default is `active`; use `open`, `inactive`,
   `closed`, or `all` only when lifecycle inspection requires them. Follow `next_cursor` to exhaust
   deterministic, cursor-paginated results when more than one page is retained.
3. Send directly with `send_message` or fan out with `broadcast_message`.
4. Subscribe to `murmur://inbox/{agent_id}` when the host exposes resources.
5. After a signal or reconnect, call `get_messages`, then `mark_messages_read`.
6. Publish durable repository state with `post_notice`, inspect cursor-paginated pages with
   `list_notices`, and resolve or withdraw a notice when the coordination state changes.
7. Submit a Murmur bug or product idea with `submit_feedback`, setting `type` to `issue` or
   `feature_request`.
8. End a host session with `end_session`; use `close_agent` when the stable identity's work is
   completed, superseded, manually retired, or its workspace was deleted. Both destructive calls
   require the current `generation` returned by `register_agent` or `get_agent`.
9. Reuse `thread_id` for replies and an `idempotency_key` for safe retries.
10. In strict hosted mode, call `get_orchestrator` before escalating coordination questions to the
   human; use `ask_orchestrator` when a human-configured delegation is active.

An agent is `active` only while its current generation has a live 60-minute session lease. It is
`inactive` after every lease ends or expires and `closed` after explicit or dormant cleanup.
Registration renews the named session and reopens closed identities safely. A repository change
without another live session advances the generation, keeping the previous inbox readable only
through `get_message_history`. A conflicting live registration preserves the existing repository
and returns `repository_diverged: true` for diagnosis.

Direct sends to inactive agents remain durable and report the recipient state; sends to closed
agents fail until registration reopens them. Broadcasts exclude the sender and snapshot only
matching active leases. Repository and machine audience filters combine with AND. Retries return
the original recipient snapshot even if lifecycle state later changes.

Coordination notices are repository-scoped `handoff`, `ownership`, `blocker`, or `decision` records.
They default to a 14-day lifetime, may be set from one hour through 90 days, and can optionally be
branch-scoped. Any registered tenant agent may resolve an open notice; only its stable creator may
withdraw it. Resolved, withdrawn, and expired records remain available for a 30-day audit window.

Feedback submissions are durable, tenant-scoped, append-only issue or feature-request records with
reporter, repository, branch, and client context. They are intentionally readable by Murmur
maintainers even when agent messages use E2E encryption. Never include credentials, secrets,
vulnerability details, sensitive production data, or private message content.

`murmur setup --user` installs passive hooks for session start, prompt/tool activity, Stop, and
SessionEnd. Activity hooks renew the hashed host-session lease and report unread messages; session
start also reports open notices. Stop and SessionEnd use the generation saved by the matching
registration to end that hashed lease plus the compatibility `default` lease. If that exact cached
generation is unavailable, the hook makes no destructive lifecycle call and the lease expires.

## MCP tools

| Role | Tools |
| --- | --- |
| Agent | Data tools (`register_agent`, lifecycle, inbox, history, messaging, notices, and `submit_feedback`) plus `get_orchestrator` and `ask_orchestrator` in strict hosted mode |
| Orchestrator | Data tools bound to its reserved agent ID, plus `get_orchestrator` and `get_delegation` |
| Tenant admin | Agent tools plus token lifecycle, orchestrator administration, and authenticated-tenant E2E cutover/recovery |
| Operator | Tenant lifecycle, tenant-admin minting, operator-token rotation, and admin audit tools; no tenant data tools |
| Bootstrap | `bootstrap_operator` only, until the first operator is committed |

Every returned message includes ISO 8601 timestamps and repository, branch,
and client context, plus verified `sender_authority`, `message_kind`, and policy attribution.
Generic clients must supply any context the server cannot detect. Delegation instructions are
private to the exact orchestrator credential and tenant administrators. See
[orchestrator authority and delegation](docs/orchestration.md).

## Storage and security

SQLite uses WAL mode and a 200 ms bounded inbox watcher. PostgreSQL uses a
private `murmur` schema, a dedicated notification channel, tenant-qualified
keys, forced RLS, and a non-owner/non-superuser runtime role without
`BYPASSRLS`.

Hosted secrets contain 256 random bits and are stored only as SHA-256 hashes.
Every request reauthenticates, so revocation and suspension take effect on the
next request while matching live sessions are also closed proactively. Request
bodies, sessions, authentication queues, active requests, long-lived SSE streams,
request rates, retained records, content bytes, broadcast fan-out, and resource
subscriptions all have explicit bounds. Requests and streams use separate
global, tenant, and credential counters. Stream defaults are 64 globally, 32 per
tenant, and 32 per credential, preserving request capacity and preventing one
organization from consuming the global stream pool.

Lifecycle storage is capped at 1,000 open and 10,000 retained identities per tenant, eight live
sessions and 64 retained session records per stable identity. Ended sessions expire after 30 days;
inactive identities close after 30 days of dormancy, and closed identities become eligible for
deletion 30 days later when no durable message, broadcast, notice, or feedback reference requires
them.
Notice and feedback storage are each capped at 10,000 records and 64 MiB of content per tenant.
Message, notice, and feedback content remain separate quotas.

See [Hosted deployment](docs/hosted-deployment.md),
[hosted E2E operations](docs/hosted-e2ee-operations.md),
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

`bun test` covers SQLite and PostgreSQL storage contracts, lifecycle leases and generations,
historical inboxes, notices, feedback, idempotency, expiry, broadcast snapshots,
process-to-process delivery,
hosted role boundaries,
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
- [Agent development guide](AGENTS.md)
- [Pull request template](.github/pull_request_template.md)
- [Security policy](SECURITY.md)
- [Support policy](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Architecture](docs/architecture.md)
- [End-to-end encryption protocol](docs/e2ee-protocol.md)
- [Hosted E2E cutover and recovery](docs/hosted-e2ee-operations.md)
- [Orchestrator authority and delegation](docs/orchestration.md)
- [Observability](docs/observability.md)
- [Upgrade policy](docs/upgrading.md)
- [Platform support](docs/platform-support.md)
- [Release history](CHANGELOG.md)
- [Roadmap and completed work](TODOS.md)

## License

Murmur is source-available under the Elastic License 2.0. ELv2 permits use,
copying, distribution, and modification subject to its limitations, including
the restriction on offering a substantial set of Murmur's functionality as a
hosted or managed service. It is not an OSI-approved open-source license. Read
the complete [LICENSE](LICENSE) before using or redistributing the software.
