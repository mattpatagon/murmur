# PostgreSQL runtime bounds

The hosted message store and control plane set the same PostgreSQL limits when establishing each
connection. These fixed values also apply when the connection pool reconnects:

| Limit | Value | Behavior at the deadline |
| --- | --- | --- |
| SQL statement | 10 seconds | PostgreSQL cancels the running statement. |
| Lock acquisition | 2 seconds | PostgreSQL rejects a statement waiting for a conflicting lock. |
| Idle transaction | 15 seconds | PostgreSQL terminates a session left idle inside a transaction. |

Transaction failures roll back before the pool can reuse the connection. A connection terminated
by the idle transaction deadline is replaced on subsequent work. Existing lifecycle and cutover
functions that set their own transaction-local lock deadline retain those explicit deadlines;
the ten-second statement ceiling still applies. Migration and operator provisioning scripts keep
their separate maintenance deadlines.

These values bound database execution and abandoned transactions. They do not replace HTTP
admission, bound total time across a multi-statement operation, or measure time waiting in the
client's connection pool. Each runtime pool retains its four-connection ceiling and ten-second
connection-establishment timeout. The message store's notification listener uses one additional
connection and inherits the statement settings without becoming an idle transaction.

Timeout failures follow the existing safe HTTP and MCP error mapping. Credential authentication
still fails closed when the backend is unavailable. Clients should retry retryable failures with
backoff and preserve message idempotency keys when retrying writes.

MCP storage failures expose only explicitly allowlisted database guidance. Unexpected database or
connection errors use `Storage operation failed. Retry the request.` without internal statements,
schema identifiers, row contents, or arbitrary driver text. Existing fixed quota, lifecycle,
encrypted-state and last-operator recovery messages remain available.

The hosted PostgreSQL test gate exercises actual message-store advisory lock contention and
credential-row contention through the control plane, then verifies that both pools recover after
the competing transaction releases its lock. The tests use isolated tenant data and release the
blocker even when the expected deadline is absent.
