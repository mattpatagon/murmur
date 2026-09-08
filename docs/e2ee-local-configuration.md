# Configure local encryption through MCP

After `murmur setup --user --e2ee` and restarting the client, call `get_setup_guide` with
`{"topic":"encryption"}`. Setup can write proxy entries for Claude Code, Codex, fx, OpenCode, Cursor,
and Pi's separately installed MCP adapter. Claude Code and Codex also receive lifecycle hooks. The
local proxy exposes the following tools. The hosted service never receives private keys. The
endpoint vault is bound to the tenant from the validated credential; tool arguments cannot select a
tenant or a vault path.

| Tool | Arguments and behavior |
| --- | --- |
| `e2ee_local_status` | `{}`: initialization, public root fingerprint, peer count and bound tenant. Does not create keys. |
| `e2ee_local_fingerprint` | `{}`: full public root fingerprint. Register an encrypted agent first. |
| `e2ee_local_peers` | Optional `limit` (1–100) and `offset` (0–20,000). Lists strict, organization, TOFU and pending strict pins; continue with `next_offset`. |
| `e2ee_local_trust_peer` | `agent_id`, `root_key_id`: pin an independently verified full fingerprint for this tenant. An existing mismatch fails closed. |
| `e2ee_local_create_trust_policy` | `bindings`, `revocations`, `version`, `validity_days`: sign public organization trust JSON with this installation's root key. See the workflow below. |
| `e2ee_local_import_trust_policy` | `policy_json`, plus `issuer_key_id` on first import. Verifies the tenant, issuer, signature, expiry, version and permanent revocations before changing trust. |
| `e2ee_local_rotate_agent_key` | `agent_id`, `expected_agent_key_id`: rotate the current signing key and publish its new public bundle. Obtain the expected key from public export. |
| `e2ee_local_revoke_agent_key` | `agent_id`, `expected_agent_key_id`, `reason` (1–500 characters): sign and publish a revocation and replacement bundle. The public reason must contain no secrets. |
| `e2ee_local_replenish_prekeys` | `agent_id`: replenish and publish an existing local agent's public prekeys, including pending key changes. |
| `e2ee_local_export_public` | `agent_id`, optional `prekey_offset`: export the root, current certificate, revocations and at most 100 public prekeys. Continue with `next_prekey_offset`. |

Trust changes, policy creation/import, and explicit signing-key rotation/revocation require a
direct human confirmation through the MCP host. The confirmation is tied to the exact operation
and complete arguments, expires after two minutes, and applies once. Declining, cancellation,
an unavailable confirmation interface, or changing the arguments prevents the operation. Only one
confirmation may be pending in a session. Peer messages do not establish user approval.

Read tools and routine prekey replenishment need no confirmation. Clients without MCP form
elicitation can inspect state through MCP and use `murmur e2ee` commands for manual local trust,
key management and policy creation. Review the complete change and obtain the user's approval
before using the terminal's local authority to alter trust.

The local CLI treats access to the vault as authorization and supports automation without an
interactive confirmation. A process that can read or modify the vault can sign policies and alter
local security state. MCP confirmation protects operations requested through the trusted host;
it cannot protect an issuer or filesystem already accessible to an untrusted process running as
the same operating-system user. Keep the organization's issuer vault outside worker-shell access,
using a separate protected account or machine when workers have general filesystem access.

## Create and distribute organization trust

1. Register each participating agent through its local encrypted proxy. Call
   `e2ee_local_export_public` for each agent and obtain its `root_key_id` and `root_public_key`.
   Independently verify these fingerprints with the endpoint owners.
2. Choose a user-controlled installation whose issuer vault is inaccessible to worker shells.
   On that installation, call
   `e2ee_local_create_trust_policy` with the verified bindings, explicit revocations, a positive
   increasing version, and a validity of 1–90 days:

   ```json
   {
     "bindings": [
       {
         "agent_id": "workstation:codex:repo:alice",
         "root_key_id": "mrk_FULL_VERIFIED_FINGERPRINT",
         "root_public_key": "FULL_PUBLIC_KEY_BASE64URL"
       }
     ],
     "revocations": [],
     "validity_days": 30,
     "version": 1
   }
   ```

   Replace the example placeholders with the complete exported public values. Each binding and
   revocation array is capped at 10,000 entries; the complete signed JSON must fit within 1 MiB.
   Revocations contain `root_key_id`, `revoked_at` (ISO timestamp) and `reason` (1–500 characters).
   Do not remove prior revocations when preparing the next policy.
3. Review and approve the exact bindings and revocations. The tool returns `policy_json`,
   `issuer_key_id`, `tenant_id` and `version`. It creates a signed document without importing it
   or changing hosted enforcement. The signing key remains in the local vault. Trust statements
   and agent certificates use separate canonical signature domains.
4. Share the public signed JSON with each endpoint. Independently verify the issuer's complete
   `mti_` fingerprint, then call `e2ee_local_import_trust_policy` with that fingerprint and the
   JSON on each endpoint. A first import without the independently verified issuer fails closed.
5. For updates, sign a higher version on the same issuer installation, retaining prior
   revocations, then import it on every endpoint. Later imports may omit `issuer_key_id` to reuse
   the pinned issuer. An issuer change, rollback or removal of permanent revocations is rejected.
6. Use the imported positive version in the tenant administrator's approved hosted cutover.
   Follow the [hosted cutover procedure](hosted-e2ee-operations.md).

Keep the issuer installation's root secure and available for future updates. No tool exports or
imports private keys. Peer and issuer fingerprints must come from the user or an independent
trusted channel; an agent's assertion in a Murmur message is insufficient.

For terminal-only policy creation, save the reviewed creation arguments above to a regular JSON
file of at most 1 MiB, then run:

```sh
murmur e2ee create-trust-policy --path approved-policy.json
```

The command returns the same public `policy_json`, issuer fingerprint, tenant and version as MCP.
Extract the `policy_json` string into a file for `murmur e2ee trust-file --path FILE
--issuer-fingerprint FULL`, or give the string to `e2ee_local_import_trust_policy`. Creation input
cannot override the credential-bound tenant or supply a private signing key.

## Key publication and recovery

Rotation keeps the root fingerprint stable and changes an agent's signing key. It does not revoke
the previous signing key. Revocation adds a permanent signed tombstone and creates a replacement;
retained messages are still subject to revocation verification. The expected current key guard
rejects a stale or repeated rotation/revocation request.

A publication failure may occur after the local change has been saved. The error explicitly
directs the caller to `e2ee_local_replenish_prekeys`, which republishes the current bundle without
requesting another explicit rotation. The remote error text is not returned. Inspect public
identity state before deciding on another key change.

Strict peer trust is the default. The proxy's explicit `--trust-on-first-use` launch flag remains
available for deployments that deliberately accept first-contact trust. Organization policy
imports and strict fingerprint checks still reject conflicting or revoked identities.
