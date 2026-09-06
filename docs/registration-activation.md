# Atomic registration activation

Registration returns an internal `RegisterAgentResult.becameActive` flag computed inside the
existing registration transaction. MCP uses that flag for `resources/list_changed` instead of
reading the full agent in a separate transaction before registration. The public registration
response is unchanged; neither `becameActive` nor `became_active` is a wire field.

An absent, inactive, or closed agent becoming active reports `true`. Re-registering an active
agent reports `false`, including another named session, session-cap replacement, and active
repository divergence. Dormant same-repository reopening reports `true` without requiring a
generation change. Inactive same-repository registration also reports `true` even though its
existing `reopened` field is `false`.

Both adapters reuse the existing pre-mutation live-session count and closed state. A session is
live only in the current generation, with no end timestamp and a lease strictly later than the
operation's clock value; registration at the exact expiry boundary reactivates the agent.
SQLite retains its immediate transaction. PostgreSQL retains tenant context, row validation,
the tenant/agent transaction lock, authority checks, session caps, and the final agent lookup.
The flag is returned only after commit, and notification delivery remains after registration.
No authentication, authorization, agent-existence, or database-result cache is introduced.

The removed PostgreSQL preread costs four protocol statements for an absent agent and five for
an existing agent, including BEGIN and COMMIT. A load journey registers two agents, removing
eight or ten statements respectively, without adding queries inside registration. These counts
exclude connection initialization and are not a latency or throughput guarantee.
Fresh PostgreSQL registration additionally omits impossible prior-session history checks,
using nine commands while active re-registration retains fourteen. The INSERT-returned generation
and final actual agent row are validated; [registration accounting](postgres-inbox-query-bounds.md)
documents the tenant-qualified foreign-key proof and unchanged quota enforcement.

`test/registration-activation.test.ts` covers SQLite lifecycle transitions, exact expiry,
authority/input rejection, capped sessions, and real in-memory MCP notifications with the
preread forbidden. `test/postgres-registration-activation.test.ts` intercepts transactions to
check query counts/order, tenant-qualified parameters, activation, divergence, and malformed-row
or authority failures through the real adapter and MCP code. It opens no database connection;
the disposable PostgreSQL and unchanged full hosted load gates remain integration and
performance acceptance requirements. `test/postgres-registration-transactions.test.ts` uses fresh
generated tenants and the real runtime role to verify concurrent activation, exact expiry,
reopening, forced RLS, direct cross-tenant mutation rejection, and actual MCP protocol-statement
counts. Its distinct agent IDs support both the initial hybrid contract and the finalized
tenant contract. The same isolation assertions also run with identical tenant-local IDs inside
`test/hosted.mcp.e2e.test.ts`, after its existing contract-finalization step; test discovery order
cannot trigger that scenario before the global v1 agent key is replaced. Both paths share
`test/support/postgres-registration-transactions.ts`, close their pools, and clean only their
generated tenants. The shared fixture does not finalize or otherwise change the database contract.
