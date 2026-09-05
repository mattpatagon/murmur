# Hosted credential admission

Every hosted request authenticates its bearer credential against PostgreSQL. The admission cache
only determines which authentication capacity a request may reserve. A cached entry never grants
tenant access, selects a role, or avoids the current revocation and suspension checks.

Each process retains at most 32,768 successfully authenticated credential hints. Entries contain
the SHA-256 digest of the credential's SHA-256 digest and the equivalent digest of the validated
tenant ID; they contain no raw bearer token, tenant ID, or cached authentication result. Operator
and bootstrap entries have no tenant hint. Guessing a valid credential's public key ID does not
match that credential's admission entry.

Successful database authentication renews an entry's five-minute lifetime and recency. Admission
lookups do not extend either. Once the cache is full, the least recently authenticated entry is
evicted. Failed authentication, malformed database authentication rows, and backend failures remove
the matching entry. Process shutdown clears the cache.

Startup, background timers, and token management no longer enumerate all active credentials.
Token creation and revocation do not flush other tenants' entries. An already cached revoked or
suspended credential can briefly receive authentication priority, but PostgreSQL rejects it on its
next request and that request removes the entry. A hint expires after five minutes without a
successful authentication even if its holder keeps attempting requests.

First use on a process, cache expiry, and eviction use the bounded unknown-credential admission
path. That first request may receive a retryable capacity rejection during a brute-force flood;
clients should retry with backoff. After successful authentication, subsequent requests receive
known-credential priority on that process. This cache bounds admission memory independently of
retained tenant count; it does not promise availability for every new credential under saturated
network or authentication capacity.
