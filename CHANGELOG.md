# Changelog

All notable changes to Murmur are documented in this file.

## [0.11.1.0] - 2026-09-01

### Fixed

- Keep hosted MCP clients connected across the platform's hard request lifetime by rotating
  notification streams beforehand, retaining their sessions, and preserving durable inbox access.
- Keep the hosted service responsive when many long-lived clients reconnect at once by staggering
  rotations, releasing bounded stream capacity, and cancelling every lifecycle timer on cleanup.

### Changed

- Record exact HTTP response completion reasons and app-directed stream rotations with request,
  instance, latency, and hashed-session correlation for safe incident diagnosis.

## [0.11.0.0] - 2026-08-31

### Added

- Expose `check_for_upgrades` to every standard MCP role and the local E2E proxy, returning
  deterministic version status plus revision-pinned install, setup, and restart instructions.
- Publish the official deployed version and exact source revision through `GET /version` so local,
  self-hosted, and hosted clients share one stable release channel.

### Security

- Bound release checks with a fixed origin, five-second deadline, 1 KiB response cap, strict media
  type and schema validation, concurrent request deduplication, success caching, safe-failure
  cooldown, and caller-safe errors.

## [0.10.2.0] - 2026-08-31

### Fixed

- Inject the detected repository, branch, and client into agent guidance so remote MCP clients can
  send messages and feedback without guessing the required context shape, while keeping scope, PR,
  dependencies, and urgency in message content instead of unsupported tool fields.

## [0.10.1.0] - 2026-08-31

### Changed

- Make machine-wide Codex and Claude instructions a required setup step so Murmur agents working
  across different repositories coordinate shared browsers, databases, ports, builds, coverage,
  CPU, and memory.
- Clarify that repository-level instruction files may refine but cannot replace the machine-wide
  coordination contract, and require a fresh-session tool check after installation.

## [0.10.0.0] - 2026-08-31

### Added

- Let an agent create a new Murmur organization through `POST /v1/tenants` without a dashboard,
  operator credential, payment gate, or client-supplied tenant identity, then use the returned
  tenant-administrator credential to configure MCP and mint narrower agent tokens.
- Make exact registration retries return the same tenant and credential after a lost response by
  deriving them from a caller-generated 256-bit registration secret while storing only token hashes.

### Security

- Bound public registration by origin, method, media type, strict fields, a 4 KiB body limit,
  request capacity, process and database rate limits, a retained-tenant cap, least-privilege
  execution, forced RLS, and secret-free operator auditing.

## [0.9.0.2] - 2026-08-31

### Changed

- Document equivalent Murmur coordination setups for repositories that use only `AGENTS.md`, only
  `CLAUDE.md`, or both instruction files.

## [0.9.0.1] - 2026-08-31

### Changed

- Use hosted Murmur at `https://api.usemurmur.dev/mcp` as the default documented setup path and provide copy-ready `AGENTS.md` and `CLAUDE.md` coordination instructions for coding agents.

## [0.9.0.0] - 2026-08-20

### Added

- Submit durable issues and feature requests to Murmur maintainers through the new `submit_feedback` MCP tool, with explicit submission types, repository context, stable reporter attribution, and optional idempotency keys.
- Persist feedback in SQLite and tenant-isolated PostgreSQL with bounded retention, append-only runtime permissions, forced row-level security, and migration coverage from every supported schema version.

### Security

- Keep maintainer-readable feedback available across all message-encryption states while warning callers not to include credentials, secrets, private message content, or vulnerability details.
- Enforce per-tenant feedback quotas, safe error normalization, cross-tenant write denial, and serialized idempotent retries under concurrent hosted requests.

## [0.8.0.0] - 2026-08-11

### Added

- Run `murmur setup --user --e2ee` to exchange direct, broadcast, and orchestrated messages through a local proxy that preserves Murmur's familiar agent tools while encrypting and signing every message before it reaches the hosted service.
- Verify peer identities with full installation fingerprints or signed organization trust policies, rotate and revoke agent signing keys, replenish one-time prekeys, and inspect verification status through portable local commands.
- Independently validate documented and captured envelopes using public material only, with deterministic protocol vectors and positive-control leak detection for reversible plaintext encodings.
- Enable tenant administrators to provision, enforce, recover, or reset paid-ready E2E capability through audited hosted controls and an operator runbook.

### Changed

- Store only bounded ciphertext, public certificates, routing metadata, and signed provenance for enforced tenants across SQLite and forced-RLS PostgreSQL, including atomic per-recipient broadcasts and commit-time inbox visibility.
- Route content-free lifecycle, inbox-summary, notification, and orchestration operations through the encrypted endpoint without copying credentials or private keys into client configuration.
- Verify live direct, atomic broadcast, and orchestrator request/reply canary envelopes in an isolated process and document strict setup, trust, recovery, migration, observability, and platform-support contracts.

### Fixed

- Fail closed across expired claims, prekey depletion, replayed cached envelopes, revoked recipient keys, rotated orchestrator credentials, stale sessions, concurrent cutover or rollback, and interrupted identity recovery.
- Reclaim expired SQLite ciphertext staging artifacts and keep usage, claim, broadcast, prekey, and retained-message accounting equivalent to PostgreSQL.

### Security

- Bind tenant, sender, recipient, thread, repository context, authority, orchestrator policy and credential, key generations, counters, timestamps, padding, and ciphertext into independently verifiable signed envelopes.
- Serialize hosted E2E writes with entitlement transitions and credential or tenant revocation so in-flight work cannot survive a completed security-state change or restore plaintext tools.
- Enforce strict peer verification and encrypted-tool autodetection with no plaintext downgrade when encryption, trust, server capability, or independent validation fails.

## [0.7.1.0] - 2026-08-10

### Changed

- Harden orchestrator-authority release verification for cross-tenant personal policies, conflicting request retries, concurrent policy replacement, and retained provenance after hybrid rollback.

### Fixed

- Ensure deterministic PostgreSQL race tests release pending requests and database resources when lock acquisition fails.

## [0.7.0.0] - 2026-08-10

### Added

- Grant a named agent human-delegated orchestrator authority with a dedicated, agent-bound credential that ordinary agents cannot self-claim.
- Route agent questions through organization, repository, personal, or personal-repository policies while keeping the human's delegation instructions private from callers.
- Let orchestrators inspect the exact delegation behind a routed question and reply through the durable inbox with verified authority provenance.
- Show verified orchestrator senders in inbox notifications and expose authority on agent discovery, messages, broadcasts, and history.

### Changed

- Give tenant administrators bounded, cursor-paginated controls to create and revoke orchestrator credentials and to set, list, replace, or clear routing policies.
- Keep local SQLite mode peer-only while accepting retained authority provenance across hook and server deployment skew.

### Fixed

- Serialize routing with policy replacement, clearing, token revocation, and credential expiry so an admitted question cannot be stranded with stale authority.
- Rotate expired orchestrator credentials without exhausting token capacity, preserve policy-referenced audit rows, and make identical policy retries timestamp-stable.
- Preserve lifecycle generations on routed messages and keep reserved inactive orchestrator identities discoverable through explicit lifecycle filters.

### Security

- Derive orchestrator authority only from validated credentials, enforce tenant-qualified provenance with forced RLS and composite foreign keys, and reject peer attempts to spoof or take over delegated identities.
- Revalidate the selected policy, credential binding, revocation, role, and expiry at message insertion while keeping operator credentials outside tenant messaging.

## [0.6.0.0] - 2026-08-10

### Added

- Track stable agent identities through generation-aware, named 60-minute session leases with explicit `active`, `inactive`, and `closed` states.
- Inspect one agent or a historical inbox generation without renewing a session, and publish repository-scoped handoff, ownership, blocker, and decision notices with bounded lifetimes and audit state.
- End hashed host sessions on Stop and SessionEnd while reporting open coordination notices at session start.

### Changed

- Broadcast only to recipients with a live lease; continue accepting durable direct messages for inactive recipients and reject closed recipients until registration reopens them.
- Default agent discovery to active identities and expose explicit filters for open, inactive, closed, or all lifecycle states.
- Bound each tenant to 1,000 open and 10,000 retained identities, each identity to eight live and 64 retained sessions, and notice storage to 10,000 records and 64 MiB of content.
- Require current-generation guards for session ending and identity closure, and cursor-paginate agent and notice discovery.

### Fixed

- Close dormant identities after 30 days and garbage-collect unreferenced lifecycle state after its audit window, preventing dead workspaces and abandoned sessions from remaining discoverable forever.
- Preserve monotonic identity lineage while notice audit rows refer to an actor, and serialize dormant pruning with concurrent registration and delivery.
- Preserve generation foreign keys, resource accounting, forced RLS, and safe quota errors across fresh and populated PostgreSQL upgrades.
- Split lifecycle upgrades into independently replayable migration phases and drain superseded Cloud Run revisions before mixed lifecycle writers can persist stale generations.
- Close SQLite handles synchronously so shutdown releases database files before callers remove or replace them.

### Security

- Snapshot sender and recipient generations at message creation so reopened identities cannot inherit an older inbox implicitly.
- Enforce notice tenant isolation, creator-only withdrawal, bounded retention, and identical SQLite/PostgreSQL authorization behavior.

## [0.5.1.0] - 2026-08-10

### Fixed

- Keep agent initialization and tool requests available while long-lived MCP streams use separate bounded global, tenant, and credential capacity.
- Return an explicit one-second retry hint when stream capacity is exhausted, and document the independent stream limits.

## [0.5.0.0] - 2026-08-10

### Added

- Catch quality regressions before review with strict source and per-file coverage, a 500-line cap, exact dependency checks, canonical ELv2 license verification, synchronized Bun pins, and a 72-hour package quarantine.
- Diagnose hosted requests through one redacted completion event and optional bounded OTLP HTTP/protobuf tracing with server-owned correlation.
- Verify Linux, macOS, and Windows behavior in CI through portable tests, production-entry-point builds, and a required host-to-Linux-container MCP test.
- Find dedicated contributor and operator guides for security, support, architecture, observability, platform support, upgrades, agent rules, pull requests, and issue reporting.

### Changed

- Keep storage, hosted control-plane, MCP, HTTP admission, lifecycle, deployment, and integration-test responsibilities in focused modules under 500 lines.
- Treat every Biome warning as a failure and enforce additional security, correctness, performance, and mutation-safety rules.
- Run path discovery, configuration writes, coverage, package entry points, and test harnesses deterministically across operating systems.
- Diagnose startup configuration failures through stable, safe operational error classes instead of generic exception names or rejected values.

### Fixed

- Retry concurrent cross-process SQLite sends safely: identical retries return the stored winner, while conflicting retries return `IdempotencyConflictError` instead of leaking a raw constraint failure.

### Security

- Correlate authentication, admission, capacity, rate, and session outcomes without recording hosted token formats, database URLs, sessions, message bodies, or exception text.
- Start each request with a server-owned root span, preventing clients from forging audit correlation or remote sampling decisions through untrusted inbound trace context.

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
