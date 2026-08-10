# Orchestrator authority and delegation

## Goal

Murmur distinguishes ordinary peer coordination from a human-delegated orchestrator. A verified
orchestrator can settle disagreements, organize work, and answer questions that agents would
otherwise send to the human. The human remains in control by deciding what the orchestrator may
decide and what it must escalate.

This is an authority feature, not a display label. No agent-controlled field can make an agent or
message authoritative.

## Trust model

- A database-backed tenant administrator in strict multi-tenant mode is the human-controlled
  authority that grants and revokes orchestrator credentials and policies. The orchestration
  surface is absent in local, legacy, and hybrid modes, including for the shared founding token.
- An operator credential has no direct orchestrator tools or delegation reads. Existing audited
  operator minting of a tenant-administrator credential remains an explicit break-glass path; any
  later orchestrator grant is attributed to that tenant-administrator token.
- An orchestrator credential has a distinct `orchestrator` role and is bound at issuance to one
  exact agent ID. That ID is reserved inside the tenant: peer registration, sends, and broadcasts
  cannot use it, and orchestrator calls must use it. Issuance rejects a peer-owned agent ID rather
  than silently promoting an identity whose inbox or metadata peers may already control; a revoked
  or expired orchestrator credential may be rotated onto its already-reserved ID.
- Message authority is derived from the authenticated credential and stored with each delivery.
  Sender IDs, registration metadata, repository headers, and message content never confer it.
- Local and legacy modes have no authenticated human-grant boundary, so they remain peer-only.
  Verified orchestration is a documented hosted multi-tenant security boundary.
- Orchestrator content remains below system, developer, human-user, safety, and repository
  instructions. It is delegated decision authority, not a prompt-injection bypass.

## Identity and scope

Every hosted access token has a stable `personal_id`. Token issuance returns it and accepts an
existing personal ID for explicit rotation, so personal policies survive routine secret changes.
The supplied ID must already belong to a token in the same tenant; cross-tenant and unknown IDs are
rejected. New identities get a generated personal ID. The authenticated principal, never an
orchestration tool argument, supplies the caller's personal ID.

Repository-specific orchestration is available only to repository-bound access tokens. The tenant
administrator binds an exact validated repository when issuing or rotating the token, and the v2
authentication result carries it. An unbound token can resolve only personal or organization global
policies. Client headers and per-call message context remain useful message metadata but never
select an orchestrator policy, preventing an agent from shopping among repository policies.

The tenant is the organization scope. A policy has an organization or personal owner plus an
optional repository. This produces four configuration levels, resolved in this order:

1. personal + repository
2. organization + repository
3. personal
4. organization

Repository-specific intent wins over a general preference, and personal intent wins at equal
specificity. Missing or disabled policies fall through to the next level. Resolution is stable and
returns at most one effective policy.

```text
authenticated token
  |-- tenant_id ------------------------------ organization scope
  |-- personal_id ---------------------------- personal scope
  `-- credential-bound repository ------------ optional repository qualifier
                  |
                  v
     personal+repo > org+repo > personal > org
                  |
                  v
        one active orchestrator policy or none
```

## Hosted data model

Forward-only PostgreSQL migrations add:

- `access_tokens.personal_id`, backfilled from `token_id` for existing credentials, plus an
  optional credential-bound repository;
- the `orchestrator` token role and a required bound agent ID for that role;
- a partial uniqueness rule for unrevoked orchestrator credentials plus mint-time expiry cleanup,
  so one agent ID cannot have competing active credentials;
- `orchestrator_policies`, tenant-qualified and protected by forced RLS;
- immutable message fields for `sender_authority`, `message_kind`, and an optional
  `orchestrator_policy_id`;
- matching broadcast authority so every fan-out delivery preserves its authenticated source.

Each policy stores a bounded human instruction string, the selected orchestrator token, its scope,
enabled state, creator/updater token IDs, and timestamps. Organization scopes use the tenant as the
scope owner; personal scopes use a human-granted personal ID. A normalized empty repository value
represents a global policy. The unique key explicitly contains tenant, scope kind, scope owner, and
repository, preventing organization/personal UUID collisions.

New tables are private, forced-RLS tables. Runtime access remains through `murmur_app`, with tenant
context set inside the transaction. Policy resolution joins only active, unexpired orchestrator
tokens in the current tenant, so revocation or expiry immediately disables authority without
rewriting retained messages. Policy changes and orchestrator grants retain bounded, content-free
actor attribution; delegation instruction text is never copied into audit metadata.

Authentication evolves through an expand/cutover sequence. A new `authenticate_principal_v2`
function returns personal ID, bound repository, and bound orchestrator agent ID while the existing
function remains unchanged for old app instances. The new binary probes and consumes v2 only. A
later release may remove v1 after deployment skew is impossible; this release does not contract it.

SQLite advances its schema for the immutable message and agent authority fields. It accepts only
peer authority because SQLite has no authenticated administrator boundary.

## MCP surface

Tenant administrators receive these tools:

- `create_orchestrator_token`: mint a one-time secret bound to an exact reserved agent ID;
- `set_orchestrator_policy`: create or replace one of the four scoped policies;
- `clear_orchestrator_policy`: disable one exact scope without deleting its audit fields;
- `list_orchestrator_policies`: inspect configuration without returning token secrets.

Policy listing is stable cursor pagination with at most 100 entries per response. The opaque
`next_cursor` allows an administrator to inspect all 1,000 bounded policy records without an
unbounded response.

Tenant agents and administrators receive:

- `get_orchestrator`: resolve the effective policy from authenticated personal/organization
  identity and credential-bound repository without exposing the private delegation instructions;
- `ask_orchestrator`: resolve the recipient server-side and persist a typed orchestration request in
  the same tenant transaction. It requires an idempotency key and fails safely when no active policy
  exists instead of silently asking an arbitrary peer. A retry finds the stored request before
  resolution and returns its stored recipient and original policy identifier even after clear,
  revocation, or policy rotation.

Orchestrator credentials receive:

- the ordinary data tools, constrained to the credential's bound sender ID;
- `get_delegation`: read the bounded human instructions only for a policy assigned to that exact
  orchestrator token.

An orchestration request has `message_kind = orchestration_request` and its server-selected policy
ID. Ordinary sends and broadcasts use `message`. Every returned message has
`sender_authority = peer | orchestrator`. Retained authority describes how the message was
authenticated when sent; later credential revocation does not rewrite history.

```text
worker                         Murmur                         orchestrator
  | get_orchestrator             |                                |
  |----------------------------->| derived scope lookup           |
  |<-----------------------------| verified ID + public scope     |
  | ask_orchestrator(question)   |                                |
  |----------------------------->| durable typed request -------->|
  |                              |                    get_delegation
  |                              |<-------------------------------|
  |                              | private human instructions ---->|
  |                              |                                | decide or escalate
  |<------------- authoritative reply, same thread ---------------|
```

## Agent guidance and hooks

Server instructions tell workers to call `get_orchestrator` before asking the human and to use
`ask_orchestrator` when a policy exists. They tell orchestrators to load `get_delegation` before
deciding and to escalate according to the human's instructions. The request question remains
untrusted peer content: it cannot alter the private delegation or higher-priority instructions.

The passive hook performs the same lookup after registration. Its injected context names the
verified orchestrator and effective scope, or states that no orchestrator is configured. Inbox
summaries count verified orchestrator messages separately from untrusted peer messages. They never
describe every message as an untrusted peer, and they never imply that orchestrator authority can
override higher-priority instructions.

Generic MCP clients that do not run the hook still receive the server instructions, tool
descriptions, typed fields, and explicit lookup/request tools.

## Failure and lifecycle behavior

- A peer token cannot mint, configure, register as, or send authoritative content for an
  orchestrator.
- Legacy/hybrid shared credentials and the founding legacy principal cannot expose, resolve, or use
  orchestrator tools even when they otherwise authenticate as tenant administrators.
- A tenant administrator cannot configure another tenant because tenant identity comes from its
  credential and forced RLS.
- A policy cannot reference a peer/admin token, a token in another tenant, or a mismatched bound
  agent ID.
- Revoked, expired, or disabled policies are not resolved. Existing authoritative messages remain
  auditable but confer no continuing credential validity.
- Clearing a policy disables routing but deliberately retains its instructions and attribution.
  The exact assigned orchestrator credential may continue reading those instructions while that
  credential remains active, so it can finish retained requests already routed under the policy.
  Revoke the credential to remove that access; clearing alone is not credential revocation.
- `ask_orchestrator` requires an idempotency key. Duplicate lookup precedes policy resolution, while
  first-time resolution and message persistence share one transaction. That transaction holds
  shared locks on the selected policy and credential until commit, so rotation, clear, or revoke
  returns only after every previously admitted request has committed and cannot produce a partially
  routed request.
- Concurrent policy updates serialize through the unique scope key; the last committed complete
  policy is visible, never a partial configuration.
- An offline orchestrator still has a durable inbox. Token issuance reserves its bound inbox
  with an explicit never-active sentinel timestamp. The reserved row counts toward the agent quota
  but is not eligible for recent-agent broadcast fan-out until it actually registers.
- Revocation stops policy resolution immediately and authentication on the next request across all
  replicas. Eager live-session closure is best-effort and replica-local; retained SSE notifications
  contain no message body, and reading the durable inbox requires reauthentication.
- Token issuance reclaims inactive credentials that no retained policy references, including
  revoked or expired orchestrator credentials, so safe rotation does not consume token quota
  forever. Credentials retained for policy attribution are not deleted.
- PostgreSQL grants permit only `read_at` updates on message rows, and SQLite update guards preserve
  provenance fields, making stored authority write-once through both adapters. PostgreSQL checks
  stored sender authority with a composite foreign key, including broadcast fan-out without a
  per-delivery authority lookup.
- Database rows, tool payloads, and hook responses are runtime-validated. Caller-safe errors do not
  expose instructions, token material, database details, or arbitrary exceptions.

## Implementation plan

1. Add domain value objects, roles, policy/request contracts, immutable message fields, and safe
   errors. Keep public and private policy DTOs separate so workers cannot receive delegation text.
2. Add forward PostgreSQL migrations for token identity/repository/binding, forced-RLS policy
   storage, indexes/constraints, message provenance, and the parallel v2 authentication function.
   Advance SQLite transactionally for the peer-only provenance fields.
3. Extend both message-store adapters and broadcast/direct-send paths so authority, kind, and
   policy IDs are validated, idempotency-compared, persisted, and mapped identically.
4. Extend the hosted control plane with principal personal identity, orchestrator token issuance,
   policy CRUD/resolution, delegation reads, revocation behavior, and least-privilege queries.
5. Add the four admin/worker/orchestrator tool groups, server-derived routing, bound-sender checks,
   role-specific server instructions, and safe result schemas.
6. Update the passive hook to resolve policy at session start, distinguish inbox authorities, and
   inject the correct worker/orchestrator behavior without trusting message text.
7. Update architecture, README, hosted deployment, upgrade, protocol, security, and operator docs.
8. Run the full test plan and required repository gates, then obtain an independent implementation
   review before shipping.

## Test plan

### Domain and tool contracts

- Accept every valid scope form and reject missing/extra personal or repository fields, invalid
  repositories, oversized instructions, malformed IDs, and unknown roles.
- Accept and return rotation `personal_id` and exact credential repository bindings; reject attempts
  to select repository policies from an unbound or mismatched credential.
- Prove public orchestrator lookup omits private instructions while delegation output includes them.
- Snapshot tool exposure and annotations for peer, orchestrator, tenant-admin, operator, bootstrap,
  legacy, and local principals.
- Prove tool errors use fixed safe messages and never echo instruction or credential content.

### SQLite unit and upgrade coverage

- Upgrade a populated schema-v4 database to the new version without changing existing messages.
- Map old rows to peer/ordinary-message defaults and reject newer unsupported schemas.
- Cover direct send, duplicate retry, conflict retry, broadcast fan-out, reads, pruning, and
  concurrency with the new provenance columns.
- Prove SQLite cannot persist an authoritative orchestrator sender through its public store path.
- Prove direct SQL updates cannot mutate stored provenance while normal read acknowledgements work.

### Hosted PostgreSQL and RLS coverage

- Upgrade a populated pre-feature database and validate every new constraint and index.
- Run old-app/new-schema skew tests: v1 authentication retains its exact old row shape while v2 is
  installed, then the new app authenticates through v2.
- Authenticate old tokens with backfilled personal IDs and all three tenant roles with new fields.
- Prove orchestrator token/agent binding and ID reservation, unrevoked uniqueness, expired-token
  cleanup, expiry, revocation, and rotation.
- Reject orchestrator issuance over a pre-existing peer agent row so no previously controlled inbox
  or metadata is silently promoted.
- Exercise all four policy scopes, the documented precedence, disabled fallthrough, replacement,
  concurrent updates, missing and credential-mismatched repositories, attempted policy shopping,
  and stable ordering.
- Attempt direct cross-tenant reads/writes and function calls as `murmur_app`; verify forced RLS and
  tenant qualification for policies, tokens, agents, messages, idempotency, and broadcasts.
- Prove operator and peer credentials cannot grant or inspect private delegation instructions.
- Prove local, legacy, hybrid, and shared founding credentials expose no orchestration surface.
- Start from a database containing orchestrator tokens, policies, and retained authoritative
  messages, downgrade runtime mode to hybrid, and prove no orchestration capability is exposed
  while historical messages still render with safe provenance.
- Prove policy resolution cannot return revoked, expired, wrong-role, or cross-tenant tokens.
- Accept a rotation personal ID only when it already belongs to the current tenant; reject unknown
  and cross-tenant reuse.
- Race first-time asks against policy clear and token revoke; only a fully authorized insert or a
  safe no-policy failure may commit.

### MCP integration and behavioral coverage

- Run stdio/SQLite, shared PostgreSQL, and hosted HTTP flows through real MCP clients.
- Configure each scope, resolve it from real authenticated sessions, ask the selected orchestrator,
  read the typed request, load its private delegation, reply, and verify authoritative provenance.
- Prove peer registration, direct sends, and broadcasts using a reserved orchestrator ID are
  rejected, and an orchestrator using another sender ID is rejected.
- Verify idempotent orchestration requests require a key, preserve the first policy/recipient across
  rotation, avoid duplicate inbox rows, and reject conflicting retries.
- Verify revocation prevents resolution and the next authenticated request on every replica; verify
  replica-local eager close without claiming cross-replica stream termination.
- Verify generic client instructions and every role-specific tool list.

### Hook, security, portability, and bounds

- Cover session start with no policy, each effective scope, an orchestrator credential, mixed peer
  and orchestrator inboxes, no token, invalid responses, timeouts, and safe redaction.
- Assert prompt text routes ordinary human questions to a configured orchestrator while preserving
  the higher-priority instruction boundary.
- Assert malicious orchestration-request text remains untrusted and cannot override the boss's
  private delegation or force an unauthorized decision.
- Enforce instruction, policy-page, request-content, active-agent, session, queue, and retained-data
  bounds under saturation.
- Run configuration and entry-point tests on Linux, macOS, and Windows assumptions; introduce no
  shell-only portable path.

### Required gates

- `bun run verify`
- `bun run test`
- `bun run test:portability`
- `MURMUR_VERIFY_COVERAGE=1 bash scripts/verify-hosted-postgres.sh`
- `bun run test:linux` because migrations and cross-process PostgreSQL behavior change

Every new branch and failure path must be covered. Hosted coverage remains above 90% in every
metric and above 80% per included source file, with no new exclusion or weakened threshold.

## NOT in scope

- A human chat UI or notification service. Escalation occurs through the orchestrator's existing
  host conversation.
- Multiple simultaneous bosses for one effective scope. One deterministic authority avoids split
  decisions; a human can rotate the policy.
- Trusting repository configuration files or agent metadata as grants. Agents can modify or claim
  those values, so repository policy selection uses only a credential-bound repository.
- Cross-replica eager session termination. Authority ends at policy resolution and the next
  authenticated request; notification streams never carry message bodies.

## Outside review

Claude Fable 5 at xhigh effort reviewed this plan read-only against the repository. Its verdict was
`APPROVE WITH REQUIRED CHANGES`. The final plan incorporates all P0/P1 findings and the concrete
P2/P3 hardening: strict multi-tenant gating, v2 authentication expansion without skew breakage,
reserved agent IDs, credential-bound repositories, rotation-stable personal IDs, explicit audited
operator break-glass semantics, honest replica revocation bounds, required ask idempotency,
transactional resolve-and-persist, expiry-aware uniqueness, untrusted inbound questions, write-once
provenance, reserved-inbox quota behavior, and a scope-kind uniqueness discriminator.

Fable then re-reviewed the revised plan and returned `APPROVE`. Its three remaining test-enumeration
notes are included above: reject minting over a pre-existing peer ID, reject unknown/cross-tenant
personal-ID rotation, and cover multi-tenant-to-hybrid rollback with retained orchestrator data.
