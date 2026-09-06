# Changelog

All notable changes to Murmur are documented in this file.

## [0.16.0.0] - 2026-09-06

### Added

- Read every institutional website page from an authored Markdown file, and retrieve the exact
  source by using its `.md` alternate URL. Rendered pages advertise and visibly link to those
  bounded, non-indexed sources; the root uses `/index.md` and the error page uses `/404.html.md`.
- Explain the coordination problems Murmur solves: machine contention, merge races, priority
  drift, the human coordination burden, peer-first communication, and optional human-granted
  orchestration. Setup, deployment, security and product boundaries remain complete without
  JavaScript.

### Changed

- Fail website source checks if an institutional page is not Markdown, and verify every raw source
  byte-for-byte during builds and production smoke tests. Deployment checks also enforce UTF-8
  Markdown, `noindex`, the existing security headers and the authored Markdown-backed 404 page.

## [0.15.1.2] - 2026-09-06

### Fixed

- End the production observer's platform-error window when its real-window observation ends, so
  the separately verified adversarial cleanup cannot make an expected, bounded 503 retry look like
  a stream-rotation failure. Platform failures during the observation still fail closed.

## [0.15.1.1] - 2026-09-06

### Fixed

- Provision the production stream observer with its own tenant's existing personal identity,
  preserving the API's rejection of unrelated or nonexistent identities.
- Retry temporary authentication-capacity rejections during observer session cleanup, within
  fixed attempt and time limits. Revoked credentials still require a confirmed terminal response;
  hosted PostgreSQL CI now exercises the observer's real SDK setup and cleanup.

## [0.15.1.0] - 2026-09-06

### Fixed

- Verify production stream rotation and reconnection using service-scoped log access, without
  requiring a project-wide log-reader role. All log queries explicitly select the service-named
  view and fail closed if access is missing; see [production log access](docs/production-log-access.md)
  for the required operator-approved setup.

## [0.15.0.1] - 2026-09-06

### Fixed

- Keep Cloud Run traffic attached to the current and future latest revision after preservation.
  Explicit revision pinning could leave a successful deployment serving the preceding release;
  the bounded cutover now removes that stale pin before verifying the ready revision and health.

## [0.15.0.0] - 2026-09-06

### Added

- Configure Claude Code, Codex, OpenCode, Cursor and Pi from the public setup flow, with explicit
  client selection, idempotent updates and conflict-safe recovery. Pi keeps its catalog-listed
  third-party MCP adapter as a separate, manual installation step; automatic hooks remain limited
  to Claude Code and Codex.
- Present Claude Code, Codex, OpenCode, Cursor, Pi, Conductor and Orca with checksum-pinned official
  marks on the website, and publish the branded site favicon through shared page metadata.
- Document the generic MCP compatibility matrix and explain how Conductor and Orca use the
  effective agent home or environment when they inherit an agent's MCP configuration.

### Changed

- Accept 1–32-character ASCII client slugs across plaintext and encrypted protocols. SQLite schema
  13 and staged PostgreSQL constraints replace the earlier closed client-name set while preserving
  tenant qualification, indexes and existing rows. Operators drain older binaries before storing
  new slugs and do not roll back to binaries that cannot read them.

## [0.14.1.0] - 2026-09-06

### Fixed

- Run shared-PostgreSQL cloud integration from isolated source installations with the frozen
  lockfile, release-age configuration and reviewed SDK patches. This avoids unsupported
  consumer-relative patch resolution in raw source tarballs while preserving protocol assertions.
- Exercise the same isolated-source cloud check against disposable PostgreSQL in pull-request CI
  before production migration/deployment. Public bundled downloads and API runtime are unchanged.

## [0.14.0.0] - 2026-09-06

### Security

- Keep hosted storage, credential admission, sessions, notifications and unfinished requests within
  shared limits that do not grow with account count. Capacity failures remain explicit and retryable.
- Bound large inboxes, directories, notices, policies, token lists, feedback and encrypted broadcasts
  before loading or serializing their contents; retain byte reservations until actual work settles.
- Preserve output backpressure for slow HTTP readers and bound incoming bytes before authentication
  finishes. Cancelled requests cannot proceed to identity lookup, parsing or application admission.
- Reject duplicate in-flight request IDs and HTTP batches before SDK dispatch, and retire sessions
  whose cancelled requests would otherwise retain SDK correlation state.
- Reserve part of the existing audit allowance for suspension and operator-token revocation without
  deleting audit history or increasing the absolute storage limits.
- Keep agent and token quota functions private to their existing database-owned triggers.

### Changed

- Return bounded pages with stable continuation cursors; oversized inbox requests explain how to
  retry with a smaller limit without losing messages.
- Use a fixed one-instance, one-CPU, 512 MiB hosted deployment policy. Resource limits intentionally
  reject excess work; they do not promise unlimited traffic or a fixed cloud bill.
- Verify hosted workloads with a disposable 25,000-account scenario covering tenant isolation,
  forged credentials, admission saturation, recovery and explicit latency and memory thresholds.
- Add an opt-in real-window production stream check with exact-revision and log-access preflight,
  same-session reconnect evidence and targeted disposable-tenant cleanup.
- Correct the pinned MCP SDK's optional session-ID declarations without changing its runtime or
  disabling strict library checks.
- Preserve compatible Cloud Run revisions and retained database rows during deployment, with
  source-provenance checks before migrations and no bypass of writer-drain safety for contraction.
- Verify digest-only deployed images against bounded registry metadata and their exact source tags
  before preserving revisions or observing production streams, without requiring Container Analysis.
- Avoid redundant fresh-agent session-history checks while retaining tenant locks, quotas,
  validated database-returned generation and final agent state, and existing-agent lifecycle behavior.

### Fixed

- Keep hosted credential enrichment on an indexed single-principal lookup instead of scanning the
  growing token directory on each request; token revocation and suspension remain authoritative.
- Reuse static tool and row schemas and remove duplicate inbox prechecks while preserving
  per-request validation, tenant isolation and independently mutable tool catalogs.
- Let the native HTTP transport finish early-response delivery before closing incomplete inputs.
- Derive registration activation inside its transaction, avoiding a redundant lookup and duplicate
  PostgreSQL activity accounting while preserving resource-list notifications.
- Read inbox pages and their independent versions in one PostgreSQL statement snapshot, preserving tenant checks,
  generation filters, and payload-byte reservations through failure or cancellation.
- Release plaintext expiry-preflight pool leases before send, read and acknowledgement
  transactions; preserve separately committed cleanup and prevent replay after operation failures.
- Require an observed successful load-worker shutdown; premature exits and forced termination fail
  verification instead of reporting successful cleanup, and failed cleanup retains the hard deadline.
- Skip redundant storage-size calculations for fixed-size usage-counter updates, with a catalog
  guard that falls back for schema changes and preserves existing quota admission ordering.

## [0.13.2.0] - 2026-09-06

### Changed

- Use, modify, redistribute, and host Murmur under the MIT License. Package metadata, contribution terms, and setup guidance now reflect the open-source license.
- Find the MIT license and public source links on the institutional website, including its FAQ, footer, and complete license page.

### Removed

- Remove the separate tarball-installation verification gate. Hosted package downloads and artifact integrity validation remain available.

### Fixed

- Allow up to 60 seconds for website publication to reach the custom domain before verifying the exact release revision.

## [0.13.1.0] - 2026-09-06

### Added

- Introduce Murmur's institutional website with product, audience, architecture, onboarding,
  security, and license pages. An interactive handoff explains durable delivery, and a client
  selector provides copyable Claude Code, Codex, and generic MCP setup instructions.
- Define the visual, content, accessibility, and performance contract in `DESIGN.md` before
  implementation. Serve static Astro pages with React islands, TypeScript, Tailwind CSS, and
  self-hosted fonts from an isolated website package.
- Automate Cloudflare Pages publication from `main`, with source and artifact checks, bounded
  deployment jobs, authenticated account verification, security headers, and revision and 404
  smoke checks for `usemurmur.dev`. Run Wrangler with the pinned Node runtime.
- Prevent Cloudflare proxy analytics injection with website response headers and verify the
  privacy policy in both artifact validation and production smoke checks.
- Add an opt-in real-window production stream check with exact-revision and log-access preflight,
  same-session reconnect evidence, and targeted disposable-tenant cleanup.

### Changed

- Preserve compatible Cloud Run revisions and retained database rows during deployment, with
  source checks before migrations and no bypass of writer-drain safety for contraction.
- Verify digest-only Cloud Run image provenance through bounded registry metadata and exact
  source-tag binding during preservation preflight and production stream observation.

### For contributors

- Install the website's frozen dependencies with `bun run website:install` before verification.
  The frontend keeps Astro's TypeScript 6 checker separate from the backend's TypeScript 7 gate.
- Extend exact dependency and file-size policies to the website, enforce safe frontend source,
  and test metadata, link, asset, clipboard, and deployment artifact failure paths.
- Correct the pinned MCP SDK's optional session-ID declarations without changing its runtime or
  disabling strict library checks.

## [0.13.0.0] - 2026-09-05

### Added

- Start setup with one Codex or Claude MCP command. The anonymous `/setup/mcp` endpoint exposes only `get_setup_guide`; the agent guides installation, signup, credentials, hooks, encryption, and administration.
- Install the bundled CLI from public hosted downloads while the source repository remains private. Linux, macOS, and Windows use the same Bun package, with included dependency notices and revision-pinned upgrade URLs.
- Create an organization with `murmur signup`, recover interrupted registration from private checkpoints, and keep owner and worker credentials separate. Setup upgrades the same-origin anonymous MCP entry automatically.
- Configure encrypted endpoints through ten local MCP tools, including public trust-policy authoring, verified peer trust, key rotation and revocation, prekey replenishment, and public export.

### Security

- Raise the minimum and pinned Bun runtime to 1.3.14, including its HTTP request-smuggling fix, across local clients, containers, and CI.
- Require approval of the exact validated administrative request through trusted-client elicitation, with expiry, replay protection, and credential revalidation. `murmur admin` provides an interactive terminal fallback; owner credentials remain outside worker processes.
- Bound anonymous setup, downloads, signup responses, and elicitation streams; protect signup credentials with POSIX permissions or Windows access controls.
- Update exact transitive overrides to `fast-uri@3.1.6` and `qs@6.16.0`, with documented advisory coverage and removal conditions.

## [0.12.2.0] - 2026-09-04

### Changed

- Guide repository and machine-wide coding agents with GPT-6 Astra-tuned initiative, instruction
  precedence, writing, delegation, and verification behavior while preserving Murmur's existing
  safety and release gates.

## [0.12.1.0] - 2026-09-03

### Fixed

- Give concurrent Codex and Claude host sessions distinct automatic Murmur agent identities inside
  the same checkout while keeping every hook from one host session on the same durable identity;
  close that identity at SessionEnd so sequential sessions release open-agent capacity.

### Security

- Use the opaque host session identifier only as hashed identity input, never expose it in the
  derived agent ID, retain the checkout-only identity when a host omits session information, and
  retire local E2E identities on close, reclaim them after the 30-day message window without
  discarding pending outbox sender keys or signed revocation history, align their bounded capacity
  with retained agents, and keep custom vault paths identical across proxies and lifecycle hooks.

### For contributors

- Keep SQLite upgrade fixtures independent of the calendar and hold migration-test table locks
  until the expected bounded timeout completes instead of relying on fixed wall-clock sleeps.

## [0.12.0.1] - 2026-09-02

### Changed

- Distinguish active-audience broadcasts from shared repository notices in MCP tool descriptions,
  server instructions, and user documentation: broadcasts create per-recipient unread inbox
  deliveries, while notices remain discoverable coordination state with an explicit lifecycle.

### For contributors

- Prove that notices create no inbox deliveries and remain visible to agents registered later.
- Give multi-process and hosted integration scenarios bounded outer budgets that accommodate process
  startup and coverage instrumentation without weakening their delivery deadlines.

## [0.12.0.0] - 2026-09-02

### Added

- Connect ChatGPT and Grok-style MCP hosts with a dedicated Murmur agent token through an
  authorization-code and S256 PKCE compatibility flow, without introducing a separate Murmur
  login or consent system.
- Publish protected-resource and authorization-server metadata plus copy-ready connector settings
  for hosted and self-hosted deployments.

### Changed

- Preserve connector-originated repository, branch, and generic `connector` client context across
  plaintext and encrypted message, broadcast, and feedback contracts.
- Apply connector client constraints through independently retryable, bounded-lock PostgreSQL
  expansion, validation, and finalization migrations.

### Security

- Derive OAuth issuer and MCP resource identity from a configured canonical HTTPS origin, require
  exact allowlisted callbacks, and reject host or forwarding-header spoofing.
- Share bounded HTTP, authentication, and tenant/principal rate controls with existing hosted
  traffic while keeping anonymous code issuance below the live in-memory code pool.
- Return the original tenant agent token only after client-secret authentication and one-use PKCE
  grant validation, so existing repository scope, expiry, suspension, rotation, and revocation
  remain authoritative.

### For contributors

- Stabilize the SDK stream-rotation regression by allowing normal client setup jitter while
  retaining a pre-rotation idle-expiry assertion.

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

## Earlier releases

See the [0.1.0.0–0.4.4.0 release history](docs/changelog-early-releases.md).
