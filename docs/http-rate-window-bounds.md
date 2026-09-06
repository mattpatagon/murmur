# HTTP rate-window bounds

Each process retains at most 65,536 rate windows across authenticated principals, tenant quotas,
and fixed public-endpoint identities. A tenant request normally uses one principal window and one
tenant window. The cap bounds rate-limiter bookkeeping independently of the number of stored
credentials; it is not a promise of 65,536 simultaneous requests or sessions.

When full, a previously unseen identity receives the existing HTTP 429 rate-limit response with
`Retry-After: 60`. Existing identities keep their counters and may use their remaining allowance.
The limiter never evicts an active counter to admit another identity, so rotating identities cannot
erase an existing throttle. Per-minute counters saturate at their configured allowance.

Windows retain the existing two-minute cleanup lifetime. Every rate check reclaims expired entries
before considering the cap. Windows are ordered by their start time, including after a minute
rollover; cleanup visits the expired prefix and stops at the first unexpired entry. It does not
copy or scan the entire map on each HTTP request. No per-identity timer is allocated.

These are per-process admission bounds. They do not replace PostgreSQL authorization, durable
storage quotas, upstream connection limits, or provider billing controls.
