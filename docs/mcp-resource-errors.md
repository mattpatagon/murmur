# MCP resource storage failures

Resource listing, inbox reads, subscriptions, and unsubscriptions apply the same PostgreSQL
error mapping as MCP tools. SQL and connection exceptions with string error codes become MCP
internal errors (`-32603`) without the original exception data. Unexpected failures return
`Storage operation failed. Retry the request.` Allowlisted quota, encryption, and accounting
guidance remains available through the shared storage mapper.

URI validation, missing-agent, subscription-capacity, and other existing domain errors retain
their protocol codes and messages. This boundary does not change tenant authorization, durable
inbox contents, or the subscription lifecycle. Operational logs record a fixed context and error
class, never the database message or arbitrary error data.

`test/mcp-resource-failures.test.ts` exercises actual SDK client requests with injected SQL and
connection failures, checks that private message/data sentinels do not cross the protocol, and
verifies recovery and existing input errors.
