# End-to-end encryption protocol

Murmur E2E uses a local process as the cryptographic endpoint. The hosted service may route,
authorize, retain, quota, and notify about encrypted records, but it never needs message plaintext
or private key material. This document is the independent interoperability contract for protocol
version `murmur-e2ee-v1`.

## Security boundary

The local OS account, MCP host, proxy, and intended agent can see plaintext. Hosted Murmur,
PostgreSQL, backups, logs, traces, and network intermediaries see routing fields, timestamps,
recipient sets, ciphertext, and a padded size bucket. Repository, branch, and client are signed
sender assertions, not external attestations. Credential-derived authority is checked by an honest
server but is not independently attested against a malicious server unless an authority certificate
is added by the orchestration contract.

Strict verification requires a root fingerprint obtained out of band or through a separately
verified organization trust file. A first root learned from Murmur alone is TOFU and must be labeled
unverified. A malicious server can censor or tail-withhold messages. Pair counters can reveal a
replay, reorder, or an observable middle gap; a gap means server-withheld or sender-abandoned.

## Dependency decision

The runtime pins `libsodium-wrappers` 0.8.4 exactly. Registry evidence checked on 2026-08-10:

- license: ISC;
- published: 2026-04-19T11:26:26.616Z;
- unpacked size: 550,010 bytes;
- integrity:
  `sha512-mu8aAWucZjTB5O/BtGXtW4e1agy7uHxNYG7zPthmmD1jU43LCDmSWZLN4JhflbdPXj3yDO4lxM1O9hLDgIOXDw==`;
- direct dependency: `libsodium` with Bun resolving the exact 0.8.4 tarball in `bun.lock`.

It provides audited high-level X25519/XSalsa20-Poly1305 boxes, Ed25519 signatures, BLAKE2b,
constant-time comparison, secure randomness, and byte-buffer wiping in a portable JS/Wasm package.
`@signalapp/libsignal-client` was rejected because outside use is unsupported, its package is native
and much larger, and its licensing/runtime surface is disproportionate for bounded inbox delivery.
Removal requires replacing every primitive and reproducing the public vectors; there is no hosted
vendor state. Wiping is best effort for `Uint8Array` values. JavaScript string erasure is not
claimed.

## Key hierarchy

1. An Ed25519 installation root identifies one local installation/profile.
2. Every agent has an Ed25519 signing key certified by that root.
3. Every recipient publishes an agent-signed rotating X25519 fallback prekey and bounded one-time
   X25519 prekeys.
4. Key IDs are the full URL-safe, unpadded base64 form of a 32-byte BLAKE2b public-key digest,
   prefixed `mrk_`, `mak_`, or `mpk_`.

An agent certificate signs this canonical order: domain, root key ID, agent ID, signing key ID,
signing public key, creation time, expiry time. A prekey certificate signs: domain, agent ID, agent
signing key ID, prekey ID, prekey class, public key, creation time, expiry time. Verification checks
the derived key IDs, identity, validity interval, key lengths, and signature.

## Canonical encoding

Every variable byte/string field is prefixed by an unsigned 32-bit big-endian length. Null uses the
reserved length `0xffffffff`; empty is length zero and differs from null. Counters are unsigned
64-bit big-endian integers restricted to JavaScript's nonnegative safe range. UTF-8 decoding is
fatal. Field order is fixed below and never depends on JSON ordering.

The signed, server-visible outer header order is:

1. domain `murmur-e2ee-v1/outer`;
2. protocol and cipher suite;
3. tenant UUID, message UUID, client idempotency key, nullable broadcast UUID;
4. sender-recipient pair counter;
5. sender ID, recipient ID, opaque thread ID;
6. nullable repository, branch, and client;
7. sender-proposed creation and expiry timestamps;
8. sender authority, message kind, nullable orchestrator policy UUID;
9. recipient root, agent-signing, prekey IDs, and prekey class;
10. sender root and agent-signing key IDs;
11. padded inner length and padding scheme.

`tenant_sequence` is an unsigned transport cursor allocated only when the hosted row becomes
visible. It and mutable `read_at` are not signed.

The encrypted inner value contains domain `murmur-e2ee-v1/inner`, an exact byte copy of the outer
header, then the exact plaintext bytes. Random bytes extend the complete inner value to the smallest
power-of-two bucket from 512 through 524,288 bytes. Exact plaintext length is therefore
confidential. The recipient verifies the outer signature before decrypting, then constant-time
compares the encrypted outer copy before releasing UTF-8 plaintext.

The signature input contains domain `murmur-e2ee-v1/signature`, outer header bytes, ephemeral
X25519 public key, 24-byte nonce, and ciphertext. All are length-prefixed. Encryption uses a fresh
ephemeral X25519 key and `crypto_box_easy`; signing uses the sender agent's Ed25519 key.

## Fixed vector

`test/e2ee-protocol.test.ts` defines the complete input for the first public vector. Its key IDs use
the production prefix plus full 32-byte-digest shape. With a padded length of 1,024, the canonical
outer header is 708 bytes and has BLAKE2b-256 digest:

```text
feac7159f60e1f6760d2c2e589b19fd221279b71e12d226feda484d4ec2cd95a
```

Implementations must reproduce this digest before attempting envelope interoperability. Runtime
encryption chooses a larger bucket when the outer copy plus plaintext cannot fit in 512 bytes.

`scripts/e2ee-independent-verifier.ts` independently reimplements the canonical encoder and public
certificate/signature checks without importing runtime E2E modules. Run its bounded CLI with:

```sh
bun run scripts/verify-e2ee-capture.ts CAPTURE.json 2026-08-10T18:00:00.000Z
```

The capture contains the public sender/recipient chains and the encrypted envelope only. A passing
result proves integrity relative to those public roots and reports their full fingerprints; it does
not make a self-presented root trusted. Compare the sender root fingerprint with an out-of-band pin
or verified organization policy before treating the sender identity as verified.

## Required receiver order

1. Validate all wire shapes, decoded lengths, enums, UUIDs, timestamps, and local bounds.
2. Re-encode the canonical outer header.
3. Verify the pinned root, agent certificate, prekey certificate, and envelope signature.
4. Check replay/pair-counter state and expected tenant/recipient/context.
5. Decrypt with the claimed local prekey.
6. Compare the confidential outer copy with the server-visible outer bytes.
7. Decode plaintext, then atomically cache it, record replay state, and delete a consumed one-time
   private prekey.
8. Only then expose plaintext to the agent.

Any failure returns a fixed verification error. Implementations must not expose library errors,
keys, raw envelope internals, plaintext, credentials, database identifiers, or session IDs.
