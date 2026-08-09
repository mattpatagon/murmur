# Changelog

All notable changes to Murmur are documented in this file.

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
