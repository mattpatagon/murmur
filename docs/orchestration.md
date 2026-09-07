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
  Sender IDs, registration metadata, machine/repository headers, and message content never confer
  it. Machine-qualified delegation uses an immutable machine value on the validated credential; it
  is not inferred from a claimed agent ID or registration metadata.
- Local and legacy modes have no authenticated human-grant boundary, so they remain peer-only.
  Verified orchestration is a documented hosted multi-tenant security boundary.
- Orchestrator content remains below system, developer, human-user, safety, and repository
  instructions. It is delegated decision authority, not a prompt-injection bypass.

## Human approval without a dashboard

Keep the tenant-administrator credential in a human-controlled secret store and use ordinary
`agent` credentials for everyday MCP connections and hooks. A worker cannot create an orchestrator,
mint an administrator credential, change delegation, or administer another organization.

Every administrative mutation also requires a server-initiated MCP form elicitation. Murmur shows
the operation, authenticated tenant, and complete validated arguments before applying it. The host
must ask the human and return the fresh confirmation for that exact pending request. An `approved`
tool argument, peer message, prior confirmation, declined form, timeout, or unsupported host cannot
authorize a change. Only one approval may be pending per session; it expires after two minutes.
Murmur revalidates the credential after approval, so a revoked credential cannot finish a pending
grant. Token issuance and revocation, orchestration configuration, E2E cutover and recovery, operator
bootstrap, and tenant creation, suspension, and restoration use this boundary.

This depends on a trusted MCP host collecting the human's decision and keeping owner credentials
outside untrusted agents. The protocol cannot distinguish a human from a rogue client that already
possesses the administrator secret. Compromised owner credentials or the human's terminal require
revocation and recovery; elicitation does not repair that compromise.

For a host without form elicitation, the portable terminal client provides the same MCP operations:

```text
murmur admin tools
murmur admin create_orchestrator_token --arguments-file grant.json
murmur admin set_orchestrator_policy --arguments-file policy.json
```

Set `MURMUR_ADMIN_TOKEN` from the human's secret store in that terminal. It is separate from the
worker's `MURMUR_API_TOKEN`. `grant.json` contains the proposed agent ID, credential name, and any
intended credential bindings:

```json
{"agent_id":"build-1-coordinator","name":"Build machine coordinator","machine":"build-1","repository":"owner/repository"}
```

After reviewing and approving the grant, save the returned one-time credential in the designated
orchestrator's secret store. Use its `key_id` in `policy.json`:

```json
{"scope_kind":"organization","machine":"build-1","repository":"owner/repository","orchestrator_key_id":"<returned key_id>","instructions":"Coordinate this repository and machine; escalate production changes to me."}
```

The terminal prints the exact request and requires the human to type `approve`. It rejects pipes
and redirected input/output and has no automatic confirmation flag. Optional `--url` selects a
self-hosted endpoint; HTTPS is required outside loopback. `murmur admin tools` returns each exposed
tool's full input schema, so organization, token, and encryption administration are discoverable
without repository access. Read-only tools do not require additional approval.

A reviewed automation plan can approve only its exact predeclared requests through
`approveExactRequest`. The adapter compares the operation and complete argument digest before
answering the current challenge. A plan's prior human authorization must cover those changes;
blanket acceptance of arbitrary server requests is not a human-approval implementation.

## Identity and scope

Every hosted access token has a stable `personal_id`. Token issuance returns it and accepts an
existing personal ID for explicit rotation, so personal policies survive routine secret changes.
The supplied ID must already belong to a token in the same tenant; cross-tenant and unknown IDs are
rejected. New identities get a generated personal ID. The authenticated principal, never an
orchestration tool argument, supplies the caller's personal ID.

Machine- and repository-specific orchestration is available only to access tokens issued with the
matching bindings. A tenant administrator may bind an exact validated `machine`, `repository`,
both, or neither when issuing or rotating an agent, tenant-admin, or orchestrator credential.
Existing and legacy credentials remain unbound after migration. The authenticated principal
carries these values; an unbound token resolves only global organization or personal policies.

The public JSON field is `machine`; `machine_name` is an internal database column. Agent IDs,
registration `metadata.machine`, headers, per-call context, environment values, and filesystem
paths remain useful operational metadata but cannot supply or override a credential binding. This
prevents policy shopping. It does not prove which physical computer presented a bearer token:
machine placement must also be enforced by keeping that secret in the named machine's workload
identity or protected secret store.

The tenant is the organization scope. A policy has an organization or personal owner plus optional,
independent machine and repository qualifiers. This produces eight forms, resolved in this order:

1. personal + machine + repository
2. organization + machine + repository
3. personal + repository
4. personal + machine
5. organization + repository
6. organization + machine
7. personal, with neither qualifier
8. organization, with neither qualifier

Both qualifiers beat one; repository-only beats machine-only; personal beats organization at equal
qualifier specificity. Missing, disabled, expired, or revoked assignments fall through in that
order. A machine-only credential can match machine and global scopes but never repository scopes;
a repository-only credential behaves symmetrically. A credential bound to both may use every
applicable fallback. Resolution is stable and returns at most one effective policy.

Issue the worker with exactly one of these four credential argument shapes:

```json
{"name":"Global worker","role":"agent"}
{"name":"Machine worker","role":"agent","machine":"build-1"}
{"name":"Repository worker","role":"agent","repository":"owner/repository"}
{"name":"Machine and repository worker","role":"agent","machine":"build-1","repository":"owner/repository"}
```

Then choose the matching organization or personal policy. Add the returned orchestrator `key_id`
as `orchestrator_key_id` and the approved delegation text as `instructions` to the selected object:

```json
{"scope_kind":"organization"}
{"scope_kind":"personal","personal_id":"<worker personal_id>"}
{"scope_kind":"organization","machine":"build-1"}
{"scope_kind":"personal","personal_id":"<worker personal_id>","machine":"build-1"}
{"scope_kind":"organization","repository":"owner/repository"}
{"scope_kind":"personal","personal_id":"<worker personal_id>","repository":"owner/repository"}
{"scope_kind":"organization","machine":"build-1","repository":"owner/repository"}
{"scope_kind":"personal","personal_id":"<worker personal_id>","machine":"build-1","repository":"owner/repository"}
```

```text
authenticated token
  |-- tenant_id ------------------------------ organization scope
  |-- personal_id ---------------------------- personal scope
  |-- credential-bound machine --------------- optional machine qualifier
  `-- credential-bound repository ------------ optional repository qualifier
                  |
                  v
 personal+both > org+both > personal+repo > personal+machine
     > org+repo > org+machine > personal > organization
                  |
                  v
        one active orchestrator policy or none
```

## Hosted data model

Forward-only PostgreSQL migrations add:

- `access_tokens.personal_id`, backfilled from `token_id` for existing credentials, plus optional
  credential-bound machine and repository values;
- the `orchestrator` token role and a required bound agent ID for that role;
- a partial uniqueness rule for unrevoked orchestrator credentials plus mint-time expiry cleanup,
  so one agent ID cannot have competing active credentials;
- `orchestrator_policies`, tenant-qualified and protected by forced RLS;
- immutable message fields for `sender_authority`, `message_kind`, and an optional
  `orchestrator_policy_id`;
- matching broadcast authority so every fan-out delivery preserves its authenticated source.

Each policy stores a bounded human instruction string, the selected orchestrator token, its scope,
enabled state, creator/updater token IDs, and timestamps. Organization scopes use the tenant as the
scope owner; personal scopes use a human-granted personal ID. Normalized empty machine/repository
values represent missing qualifiers. The unique key explicitly contains tenant, scope kind, scope
owner, machine, and repository, preserving all eight combinations without owner collisions.

New tables are private, forced-RLS tables. Runtime access remains through `murmur_app`, with tenant
context set inside the transaction. Policy resolution joins only active, unexpired orchestrator
tokens in the current tenant, so revocation or expiry immediately disables authority without
rewriting retained messages. Policy changes and orchestrator grants retain bounded, content-free
actor attribution; delegation instruction text is never copied into audit metadata.

The machine expansion adds `authenticate_principal_v3`, which returns the v2 fields plus the bound
machine. The v2 function remains unchanged for old app instances during rolling drain; the new
binary requires and consumes v3. Existing token machine values backfill to null and existing policy
machine values to the normalized empty value, so they retain global semantics. This forward
migration does not reinterpret metadata as authority.

SQLite advances its schema for the immutable message and agent authority fields. It accepts only
peer authority because SQLite has no authenticated administrator boundary.

## MCP surface

Tenant administrators receive these tools:

- `create_orchestrator_token`: mint a one-time secret bound to an exact reserved agent ID;
- `set_orchestrator_policy`: create or replace one of the eight scoped policies;
- `clear_orchestrator_policy`: disable one exact scope without deleting its audit fields;
- `list_orchestrator_policies`: inspect configuration without returning token secrets.

Policy listing is stable cursor pagination with at most 100 entries per response. The opaque
`next_cursor` allows an administrator to inspect all 1,000 bounded policy records without an
unbounded response.

Tenant agents and administrators receive:

- `get_orchestrator`: resolve the effective policy from authenticated personal/organization
  identity and credential-bound machine/repository without exposing private instructions;
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

If you have only an existing `agent` token, you cannot create or promote an orchestrator. Repository
or hosted-service ownership is not Murmur tenant authority. Ask that tenant's administrator for a
separate owner connection; if it is lost, a service operator can issue recovery access with
`mint_tenant_admin_token`. Without either authority, signup creates a separate tenant and does not
attach the old worker, policies, or retained messages.

## Failure and lifecycle behavior

- A peer token cannot mint, configure, register as, or send authoritative content for an
  orchestrator.
- Legacy/hybrid shared credentials and the founding legacy principal cannot expose, resolve, or use
  orchestrator tools even when they otherwise authenticate as tenant administrators.
- A tenant administrator cannot configure another tenant because tenant identity comes from its
  credential and forced RLS.
- A policy cannot reference a peer/admin token, a token in another tenant, or a mismatched bound
  agent ID.
- A machine/repository-qualified policy cannot be selected through agent-controlled metadata or
  context; the corresponding authenticated credential binding must match exactly.
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

## Implementation record

The shipped feature is layered as follows:

1. Domain value objects, roles, policy/request contracts, immutable message fields, and safe errors
   keep public and private policy DTOs separate so workers cannot receive delegation text.
2. Forward PostgreSQL migrations for token identity/machine/repository binding, forced-RLS
   policy storage, indexes/constraints, message provenance, and versioned authentication functions.
   pair with a transactional SQLite advance for peer-only provenance fields.
3. Both message-store adapters and broadcast/direct-send paths validate, idempotency-compare,
   persist, and map authority, kind, and policy IDs identically.
4. The hosted control plane handles principal personal identity, orchestrator token issuance,
   policy CRUD/resolution, delegation reads, revocation behavior, and least-privilege queries.
5. Admin, worker, and orchestrator tool groups enforce server-derived routing, bound-sender checks,
   role-specific server instructions, and safe result schemas.
6. The passive hook resolves policy at session start, distinguishes inbox authorities, and injects
   the correct worker/orchestrator behavior without trusting message text.
7. Architecture, README, hosted deployment, upgrade, protocol, security, and operator docs expose
   the feature without requiring a repository checkout.
8. The full verification plan and required repository gates run before release.

## Verification coverage

### Domain and tool contracts

- Accept all eight scope forms and reject missing/extra personal, machine, or repository fields,
  invalid qualifiers, oversized instructions, malformed IDs, and unknown roles.
- Accept and return rotation `personal_id` and exact credential machine/repository bindings; reject
  attempts to select qualified policies from an unbound or mismatched credential.
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
- Run old-app/new-schema skew tests: v2 authentication retains its exact old row shape while v3 is
  installed, then the new app authenticates through v3.
- Authenticate old tokens with backfilled personal IDs and all three tenant roles with new fields.
- Prove orchestrator token/agent binding and ID reservation, unrevoked uniqueness, expired-token
  cleanup, expiry, revocation, and rotation.
- Reject orchestrator issuance over a pre-existing peer agent row so no previously controlled inbox
  or metadata is silently promoted.
- Exercise all eight policy scopes, the documented precedence, disabled fallthrough, replacement,
  concurrent updates, missing and credential-mismatched qualifiers, attempted policy shopping, and
  stable ordering.
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
  Prove metadata cannot impersonate a credential-bound machine.
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
- Trusting machine/repository configuration files, headers, or agent metadata as grants. Agents can
  modify or claim those values, so policy selection uses only credential-bound qualifiers.
- Cross-replica eager session termination. Authority ends at policy resolution and the next
  authenticated request; notification streams never carry message bodies.

## Review record

Claude Fable 5 at xhigh effort reviewed this plan read-only against the repository. Its verdict was
`APPROVE WITH REQUIRED CHANGES`. The final plan incorporates all P0/P1 findings and the concrete
P2/P3 hardening: strict multi-tenant gating, versioned authentication expansion without skew
breakage, reserved agent IDs, credential-bound qualifiers, rotation-stable personal IDs, audited
operator break-glass semantics, honest replica revocation bounds, required ask idempotency,
transactional resolve-and-persist, expiry-aware uniqueness, untrusted inbound questions, write-once
provenance, reserved-inbox quota behavior, and a scope-kind uniqueness discriminator.

Fable then re-reviewed the revised plan and returned `APPROVE`. Its three remaining test-enumeration
notes are included above: reject minting over a pre-existing peer ID, reject unknown/cross-tenant
personal-ID rotation, and cover multi-tenant-to-hybrid rollback with retained orchestrator data.
