# Murmur end-to-end encryption protocol

Status: `murmur-e2ee-v1`. This document is the interoperability contract for clients and
independent verifiers. It describes cryptographic bytes, trust decisions, and server-visible
metadata. Wire-tool schemas and storage transitions are documented separately.

## Security boundary

The local `murmur-e2ee-proxy` is the encryption endpoint. It receives plaintext from the local MCP
host, stores private key material in an owner-only SQLite vault, and sends only ciphertext, public
key material, and bounded routing metadata to hosted Murmur. The recipient proxy verifies and
decrypts before returning plaintext to its local MCP host.

The protocol protects message content from hosted Murmur, its database, operators, network
observers under TLS termination, logs, traces, and notifications. It does not hide routing metadata,
timing, ciphertext size buckets, or traffic volume. It does not protect plaintext from the intended
local agent, its MCP host, its OS account, or a compromised endpoint.

Hosted delivery remains authoritative. Notifications are hints to reread the durable ciphertext
inbox. The unsigned hosted inbox sequence and mutable `read_at` state are not cryptographic proof
that the server returned a complete tail.

## Algorithms and identifiers

- Root and agent signing keys: Ed25519.
- Recipient prekeys and per-envelope ephemeral keys: X25519-compatible libsodium box keys.
- Authenticated encryption: XSalsa20-Poly1305 through `crypto_box_easy`.
- Signatures: detached Ed25519.
- Key identifiers: BLAKE2b-256 of the exact 32-byte public key, base64url without padding, prefixed
  with `mrk_` for installation roots, `mak_` for agent signing keys, or `mpk_` for prekeys.
- Binary integers: unsigned big-endian. Values represented in JavaScript must also be safe
  integers.
- Binary strings: fatal UTF-8, prefixed by a four-byte unsigned byte length.
- Binary byte strings: prefixed by a four-byte unsigned byte length.
- Nullable strings: the four-byte marker `0xffffffff` means null; non-null strings use the normal
  length-prefixed encoding.
- Public wire bytes: canonical base64url without padding.

Every canonical field is at most 65,536 UTF-8 bytes. Decoders reject truncation, noncanonical
base64url, wrong key lengths, unknown algorithms, inconsistent provenance, and trailing structure
where the enclosing schema does not allow it.

The fixed suite values are:

```text
protocol       = murmur-e2ee-v1
cipher_suite   = x25519-xsalsa20-poly1305+ed25519
padding_scheme = power-of-two-v1
```

## Key hierarchy and certificates

An installation creates one Ed25519 root locally. The root private key never leaves the vault. It
certifies one or more agent signing generations. An agent signing generation certifies X25519
prekeys.

The canonical agent-certificate fields, in order, are:

```text
string  "murmur-e2ee-v1/agent-certificate"
string  root_key_id
string  agent_id
string  signing_key_id
bytes   signing_public_key
string  created_at
string  expires_at
```

The root signs those bytes with Ed25519. A verifier derives both key IDs from the public keys,
requires the expected agent identity, checks the validity window, and verifies the signature.

The canonical prekey-certificate fields, in order, are:

```text
string  "murmur-e2ee-v1/prekey-certificate"
string  agent_id
string  agent_signing_key_id
string  prekey_id
string  prekey_class             # one_time or fallback
bytes   prekey_public_key
string  created_at
string  expires_at
```

The current agent signing key signs those bytes. A verifier derives `prekey_id`, checks the agent
and signing generation, checks the validity window, and verifies the signature.

An agent signing-key revocation is signed by the stable installation root. Its canonical fields,
in order, are:

```text
string  "murmur-e2ee-v1/agent-key-revocation"
string  root_key_id
string  agent_id
string  revoked_signing_key_id
string  revoked_at
string  reason
```

Revocations are cumulative, sorted by revoked signing-key ID, and bounded to 100 per agent bundle.
The current signing key cannot appear in the revocation set. A verifier derives the root ID,
requires the exact agent identity and a non-future revocation time, and verifies the root
signature. Hosted publication rejects removal or mutation of a previously published revocation
and rejects installation-root substitution.

One-time prekey private material is deleted atomically after the first verified decryption and
replay-ledger update. A fallback private prekey may decrypt multiple messages and therefore gives a
weaker forward-secrecy class. Its validity covers message retention plus clock and rotation grace.
There is never a plaintext fallback.

## Envelope header

The signed outer header contains these logical fields:

| Field | Meaning |
| --- | --- |
| `tenant_id` | Tenant derived from the authenticated hosted credential |
| `message_id` | UUID for this exact delivery |
| `idempotency_key` | Logical operation identity bound to exact content |
| `broadcast_id` | Broadcast UUID or null for direct delivery |
| `pair_counter` | Strictly positive sender-recipient counter |
| `sender_id`, `recipient_id` | Exact endpoint identities |
| `thread_id` | Durable conversation identity |
| `repository_name`, `branch_name`, `client` | Nullable sender-asserted context |
| `created_at`, `expires_at` | Sender-proposed bounded UTC instants |
| `sender_authority` | `peer` or `orchestrator` |
| `message_kind` | `message` or `orchestration_request` |
| `orchestrator_policy_id` | Policy UUID for orchestration, otherwise null |
| recipient key IDs/class | Root, agent, and claimed prekey binding |
| sender key IDs | Root and agent signing-generation binding |
| `padded_length` | Exact padded inner byte count |

Provenance is a closed consistency rule. A normal message is
`peer / message / null` or `orchestrator / message / null`. A request routed by a peer to its
server-selected orchestrator is `peer / orchestration_request / non-null-policy-UUID`. Every other
combination is invalid.

Hosted `tenant_sequence` and `read_at` are intentionally excluded: the sequence is allocated only
when a row becomes visible at commit, and read state is mutable. Both remain validated transport
metadata.

## Canonical outer header

The canonical outer bytes contain these values in this exact order:

```text
string           "murmur-e2ee-v1/outer"
string           protocol
string           cipher_suite
string           tenant_id
string           message_id
string           idempotency_key
nullable-string  broadcast_id
u64              pair_counter
string           sender_id
string           recipient_id
string           thread_id
nullable-string  repository_name
nullable-string  branch_name
nullable-string  client
string           created_at
string           expires_at
string           sender_authority
string           message_kind
nullable-string  orchestrator_policy_id
string           recipient_root_key_id
string           recipient_agent_key_id
string           recipient_prekey_id
string           recipient_prekey_class
string           sender_root_key_id
string           sender_agent_key_id
u32              padded_length
string           padding_scheme
```

Changing any listed field changes signed bytes. JSON member order is irrelevant because JSON is
parsed and re-encoded into this canonical sequence before verification.

## Encryption and signature

The unpadded inner bytes are:

```text
string  "murmur-e2ee-v1/inner"
bytes   canonical_outer_header
bytes   plaintext_utf8
```

Choose the smallest power-of-two bucket from 512 through 524,288 bytes that can hold the inner
bytes. Fill the rest with cryptographically random bytes. The chosen size becomes
`header.padded_length`; then rebuild the outer header and inner bytes with that final value before
encryption. A decoder recomputes the canonical bucket from the decoded inner structure and rejects
another bucket.

Generate a new ephemeral X25519 key pair and a 24-byte nonce for every envelope. Encrypt the padded
inner bytes with `crypto_box_easy(padded_inner, nonce, recipient_prekey_public_key,
ephemeral_private_key)`. Ciphertext length must equal `padded_length + 16`.

The Ed25519 signature input is:

```text
string  "murmur-e2ee-v1/signature"
bytes   canonical_outer_header
bytes   ephemeral_public_key       # 32 bytes
bytes   nonce                      # 24 bytes
bytes   ciphertext
```

The current sender agent signing key signs those bytes. Verification must occur before decryption.
After authenticated decryption, decode the embedded outer bytes and compare them in constant time
with the visible canonical outer header. A mismatch, bad signature, bad box authentication, wrong
length, malformed UTF-8, or noncanonical padding produces the same fixed verification failure.

## Trust and rotation

Strict mode requires an exact full root fingerprint expectation or a valid signed organization
trust policy before first contact. Successful verification pins the peer root per tenant and agent.
An unknown or changed root fails closed. Explicit trust-on-first-use is weaker and every affected
result remains labeled `tofu` until independently verified.

Organization trust policies have a separately verified issuer fingerprint, monotonically
increasing version, validity window, exact agent/root bindings, and cumulative revocations. An
update cannot change its issuer, roll back its version, remove a revocation, or rotate a bound root
without revoking the prior root.

Agent signing keys rotate under the stable installation root. `murmur e2ee revoke-agent-key`
persists a root-signed revocation before rotation and deletes the revoked generation's private
prekeys. A crash between those steps is fail-closed: the next local identity operation detects the
revoked current key and rotates it before publication. The next proxy registration publishes the
cumulative revocation set with the replacement public bundle.

Old generations and their public certificates remain verifiable for retained messages while
valid. Revocation blocks a revoked key from becoming current again, rejects new claims and new
messages, and does not rewrite the sender chain or signed provenance captured on retained
ciphertext.

## Direct and broadcast atomicity

A direct sender first claims one recipient prekey. It durably stores the exact encrypted envelope
in its local outbox before the hosted write. A retry under the same idempotency key must resend the
same bytes. If an uncommitted claim expires, the sender retires it, advances the pair counter, and
encrypts under a fresh claim. Counters are never reused.

A broadcast snapshots and sorts its exact audience, claims a prekey per recipient, and creates a
distinct ciphertext per recipient. Deliveries remain invisible until every snapshot member has one
valid upload and the hosted commit transaction allocates inbox sequences. Cancellation or expiry
releases pending claims; a partial broadcast never becomes visible.

## Independent verification

`scripts/e2ee-independent-verifier.ts` intentionally does not import runtime envelope or
certificate code. Given a captured public chain and ciphertext envelope, it independently derives
key IDs, verifies certificate signatures and identity links, encodes the header described above,
checks ciphertext dimensions and provenance, and verifies the detached envelope signature. The
public vector in `test-vectors/e2ee-v1-header.json` pins canonical header bytes and their
BLAKE2b-256 digest across implementations.

Independent signature verification proves public authenticity and immutable context; it does not
decrypt content or prove that hosted Murmur returned every retained message.
