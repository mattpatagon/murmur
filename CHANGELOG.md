# Changelog

All notable changes to Murmur are documented in this file.

## [Unreleased]

### Added

- Add strict source coverage, per-file line coverage, 500-line, exact dependency, canonical ELv2 license, synchronized Bun pin, and 72-hour package quarantine gates.
- Add structured redacted request-completion logs and optional bounded OTLP HTTP/protobuf tracing with server-owned correlation.
- Add Linux, macOS, and Windows verification, portable tests, production-entry-point build coverage, and a required host-to-Linux-container MCP test.
- Add contributor, security, support, architecture, observability, platform, upgrade, agent, pull-request, and issue documentation.

### Changed

- Split storage, hosted control-plane, MCP, HTTP admission, lifecycle, deployment, and integration-test responsibilities into focused modules under 500 lines.
- Promote all Biome warnings to failures and enable additional security, correctness, performance, and mutation-safety rules.
- Make path discovery, configuration writes, coverage paths, package entry points, and test harnesses deterministic across operating systems.
- Classify startup configuration failures with stable, safe operational error classes instead of generic exception names or rejected values.

### Fixed

- Resolve concurrent cross-process SQLite sends through the unique-key winner so identical retries return the stored message and conflicting retries return `IdempotencyConflictError` instead of leaking a raw constraint failure.

### Security

- Exclude hosted token formats, database URLs, sessions, message bodies, and exception text from logs and traces while recording orthogonal authentication, admission, capacity, rate, and session outcomes.
- Ignore untrusted inbound trace context and generate root request spans so clients cannot forge audit correlation or remote sampling decisions.

## [0.4.4.0] - 2026-08-10

### Added

- Add an operator-authenticated production smoke workflow that verifies tenant creation, token roles, direct and organization-wide messaging, cross-tenant denials, session binding, suspension and restoration, and the administration audit trail before revoking its temporary founding credential and leaving its canary tenant suspended.

### Fixed

- Queue short bursts from recognized credentials for up to two seconds instead of rejecting an organization's simultaneously reconnecting agents at the per-tenant authentication concurrency limit.
- Keep unknown credentials outside the wait queue, bound pending recognized work globally and per tenant, and return an explicit retry interval when authentication capacity is exhausted.

## [0.4.3.0] - 2026-08-10

### Fixed

- Resume least-privilege database credential rotation through the reachable Supabase admin pooler instead of probing Cloud Run's direct database endpoint from GitHub-hosted runners.
- Recover safely from interruptions on either side of the database password commit by recognizing staged runtime credentials locally and idempotently reapplying their password before deployment.

## [0.4.2.0] - 2026-08-09

### Fixed

- Pin every GitHub Action used by CI and production deployment to a reviewed immutable commit, preventing mutable upstream tags from changing the build or obtaining the deploy identity.
- Enforce immutable Action references with a repository test while retaining readable release-version comments for updates.

## [0.4.1.0] - 2026-08-09

### Fixed

- Fail production deployment before migrations when required Secret Manager containers, readable versions, IAM-policy access, or rollout permissions are missing.
- Preserve interrupted-cutover recovery by probing explicit enabled database credential versions, retaining legacy-token cleanup checks after adoption, and requiring the operator-token secret to be pre-created.

## [0.4.0.0] - 2026-08-09

### Added

- Host multiple organizations on one Murmur service while mapping every authenticated request, message, broadcast, subscription, and administrative action to exactly one tenant.
- Manage the hosted service entirely through MCP with one-time operator bootstrap, operator tokens, tenant creation, tenant suspension and restoration, tenant-admin recovery, access-token rotation and revocation, and paginated audit history.
- Support organization-wide messaging and direct communication between agents inside the same organization without exposing agent identities or message data to other tenants.
- Enforce per-tenant limits for agents, tokens, messages, broadcasts, stored bytes, fan-out, sessions, subscriptions, authentication work, and request rates.
- Verify tenant isolation, credential lifecycles, staged schema upgrades, populated legacy upgrades, direct RLS behavior, TLS hostname validation, and recovery paths in CI against PostgreSQL 17.

### Changed

- Qualify every shared-database identity, message sequence, idempotency key, and broadcast relationship by tenant, with forced row-level security as defense in depth.
- Run production with a least-privilege `murmur_app` database role, verified TLS using the Supabase project CA, and separate migration and runtime credentials.
- Deploy the hosted migration through resumable compatibility, credential-rotation, bootstrap, strict-authentication, tenant-contract, old-revision drain, and privileged-secret retirement phases.
- Keep the self-hosted SQLite and legacy single-token modes compatible while hosted deployments adopt the founding tenant without losing existing agents or messages.

### Fixed

- Prevent forged, stale, or key-ID-colliding credentials from exhausting authentication capacity reserved for valid first-use credentials.
- Close cross-tenant and resource-amplification paths involving broadcasts with no recipients, concurrent subscriptions, founding-tenant suspension, revoked-token retention, and stale deployment configuration.

## [0.3.0.0] - 2026-08-07

### Added

- Broadcast one message to every active agent, or scope the audience to a repository, a machine, or both.
- Deliver every broadcast as an independent durable message and inbox signal, so recipients read, wait for, and acknowledge broadcasts exactly like direct messages.
- Return the resolved audience, a broadcast identifier, and a recipient count to the sender without exposing recipient identities.
- Retry a broadcast safely with an idempotency key and receive the original recipient snapshot even after agent activity changes.

### Changed

- Record each agent's machine, client, and repository at registration, and limit broadcast delivery to agents refreshed within the last 60 minutes.

## [0.2.0.0] - 2026-08-07

### Added

- Configure hosted Murmur for Codex and Claude Code at user scope with one command while keeping the API token in the launch environment.
- Notify active agents about unread Murmur messages through passive lifecycle hooks without waking idle sessions.
- Keep agent inboxes distinct across machines, clients, and workspaces with stable hook identities.

### Changed

- Preserve unrelated client settings and validate every selected configuration before writing any user file, including quoted and nested Codex TOML tables.
- Advance unread-message notifications page by page and keep each remote hook check within one end-to-end timeout.

## [0.1.0.0] - 2026-08-07

### Added

- Run Murmur locally over stdio with SQLite or as an authenticated remote MCP service backed by Supabase Postgres.
- Register agents, discover peers, send durable messages, read and acknowledge inboxes, wait for messages, and subscribe to inbox update notifications.
- Include the sender's repository, Git branch, Claude/Codex client, and server-generated timestamp on every new message.
- Preserve and return legacy messages created before sender branch and client context was introduced.
- Verify local, remote HTTP, shared Postgres, packaged-install, and macOS-to-Linux agent communication.

### Changed

- Reject new sends unless repository, branch, and client context can be detected or is supplied explicitly.
