# Hosted end-to-end encryption operations

This runbook controls a tenant's forward migration from hosted plaintext messages to
`murmur-e2ee-v1`. Only a live tenant-administrator credential may read or change its authenticated
tenant's encryption state. Operator, agent, orchestrator, and cross-tenant credentials do not expose
these tools. Tenant identity always comes from the validated credential, never an MCP argument.

The durable PostgreSQL inbox remains authoritative. In enforced mode it stores validated public
key material, signed envelopes, ciphertext, fixed-size padding metadata, routing metadata, and read
state. Private keys and plaintext remain in each endpoint's owner-only local vault.

## State and session contract

The server-derived state follows this path:

```text
off -> provisioning -> provisioning with plaintext writes blocked -> enforced
 ^                                                                  |
 +---------------- guarded rollback, only with no E2E work ---------+
```

Every effective transition closes all live MCP sessions for the tenant. Clients must reconnect and
reload the authoritative tool list. Repeating the already-completed action with the matching
`expected_state` returns `changed: false`; it does not duplicate audit records or session closure.

- `off` exposes plaintext message and notice tools. Encrypted storage tools are absent.
- `provisioning` adds key-bundle publication while plaintext reads remain available.
- `block_plaintext_writes` removes plaintext message and notice mutations but retains plaintext
  reads so the backlog can be drained.
- `enforced` removes plaintext inbox, history, wait, and notice tools. It exposes only encrypted
  inbox, key, direct-send, and atomic-broadcast operations plus tenant metadata.

PostgreSQL also rejects plaintext message inserts after the write block, independently of MCP tool
exposure. Forced RLS applies to every E2E table for the non-owner runtime role.

## Cutover procedure

First inspect the tenant through its administrator session:

```json
{"name":"get_e2ee_entitlement","arguments":{}}
```

The result reports `state`, `plaintext_writes_blocked`, `unread_plaintext_messages`,
`unprovisioned_active_agents`, `retained_ciphertext_messages`, and `trust_policy_version`.

1. Start provisioning with `transition_e2ee`:

   ```json
   {
     "action": "begin_provisioning",
     "expected_state": "off"
   }
   ```

2. Reconnect every active endpoint through `murmur setup --user --e2ee`, register its agent, verify
   installation fingerprints independently, pin trusted peers, and publish the current key bundle.
   The entitlement must report `unprovisioned_active_agents: 0`. An active agent means the current
   open generation has a live session lease.
3. Drain or explicitly read every retained plaintext inbox item until
   `unread_plaintext_messages: 0`. Preserve any required record outside Murmur under the
   organization's approved data policy before marking it read.
4. Block new plaintext writes:

   ```json
   {
     "action": "block_plaintext_writes",
     "expected_state": "provisioning"
   }
   ```

5. Reconnect and prove peer-to-peer encryption across the actual endpoint and repository boundary:
   send a unique sentinel, decrypt it only at the recipient proxy, and verify the database contains
   one ciphertext row and no sentinel or plaintext message row.
6. Enforce with the independently verified, positive organization trust-policy version:

   ```json
   {
     "action": "enforce",
     "expected_state": "provisioning",
     "trust_policy_version": 7
   }
   ```

Enforcement fails unless plaintext writes are blocked, the unread plaintext count is zero, every
active agent generation has a key bundle, and the trust-policy version is positive. The database
trigger repeats these checks inside the state transaction.

## Orchestrator encryption

Strict multi-tenant orchestration uses the same encrypted claim and envelope flow. A peer's routed
ask is signed as `peer / orchestration_request / policy UUID`; an orchestrator reply is
`orchestrator / message / null`. The server resolves and revalidates the authenticated personal,
repository, token, and policy binding in the same transaction that claims the orchestrator prekey.
Client headers and envelope fields cannot select a different orchestrator or policy. Revocation,
rotation, repository mismatch, or policy change fails closed before ciphertext is accepted.

## Capacity and retention

Each publication accepts at most 20 live one-time prekeys plus one fallback prekey. A direct or
broadcast delivery accepts at most 524,304 ciphertext bytes, representing a maximum 512 KiB padded
inner payload plus authenticated-encryption overhead. Broadcasts snapshot at most 100 active
recipients and commit all deliveries atomically. Messages expire after the normal 30-day retention
window; expired claims, broadcasts, deliveries, and ciphertext are removed by bounded pruning.

Per tenant, PostgreSQL caps active claims at 10,000, pending broadcasts at 1,000, pending deliveries
at 10,000, public prekeys at 100,000, retained ciphertext messages at 100,000, pending ciphertext at
64 MiB, and retained ciphertext at 256 MiB. Admission rejects the transaction before crossing a
bound. Never raise one layer without reviewing application validation, database constraints,
operational capacity, tests, and this document together.

## Rollback and recovery

`rollback_off` is a capability rollback, not decryption or conversion. It is refused while any
retained ciphertext, live claim, pending broadcast, or pending delivery exists. Wait for bounded
expiry and pruning, then call:

```json
{
  "action": "rollback_off",
  "expected_state": "enforced"
}
```

Losing an endpoint root does not authorize copying a private vault. Replace the machine, import and
independently verify organization trust, then have a tenant administrator call:

```json
{
  "agent_id": "exact-agent-id",
  "expected_root_key_id": "mrk_EXACT_CURRENT_ROOT_FINGERPRINT",
  "reason": "incident-1234: endpoint root was lost"
}
```

`reset_e2ee_identity` requires the exact current root ID and a trimmed 10-to-500-character reason.
It refuses while the agent participates in an unconsumed live claim or pending broadcast. A
successful reset deletes only that endpoint's published bundle, prekeys, and dependent claims,
closes tenant sessions, and records the previous root and reason in the admin audit log. Retained
ciphertext stays immutable and may remain decryptable by endpoints that still hold the relevant
private keys. A missing agent bundle returns `reset: false`; a root mismatch fails closed.

## Verification and monitoring

Before and after cutover, capture the tenant-admin state and audit events
`tenant_e2ee.transition` and `tenant_e2ee_identity.reset`. Do not include raw tokens, database URLs,
private keys, message bodies, ciphertext, or reset details beyond the incident reference in logs or
shared chat.

The authoritative hosted database gate is:

```bash
MURMUR_VERIFY_COVERAGE=1 bash scripts/verify-hosted-postgres.sh
```

It provisions a disposable PostgreSQL 17 database, runs the real hosted MCP lifecycle, proves
ciphertext decryption, checks zero plaintext persistence, probes same- and cross-tenant RLS, rejects
direct state mutation and plaintext insertion, verifies public-role denial, exercises a populated
upgrade, runs security advisors, and enforces hosted coverage. Production canaries also confirm the
current tenant tool matrix, deliver a sentinel between independently authenticated cross-repository
endpoints, atomically fan encrypted broadcast ciphertext to two recipients, complete an encrypted
orchestrator request/reply with server-issued provenance, and pass every captured live envelope
through the isolated independent verifier process.
When an operator claims cross-machine coverage, run the sender and receiver endpoints from separate
hosts; machine metadata alone is not evidence of host isolation.
