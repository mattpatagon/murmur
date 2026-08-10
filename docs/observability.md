# Observability

Murmur emits one structured completion event for every hosted HTTP request and can export bounded
OpenTelemetry server spans. The contract prioritizes safe correlation and failure diagnosis without
recording agent messages or credentials.

## Structured logs

Logs are newline-delimited JSON on stdout (`INFO`) or stderr (`ERROR`). `MURMUR_LOG_LEVEL` accepts
`info` (the default) or `off`. Any other value fails hosted startup. Do not disable logs in production
unless the platform supplies an equivalent audited request event.

Every record contains:

- `timestamp`, `severity`, `event`, and `message`;
- `service`, `service_version`, `runtime`, and `runtime_version`;
- `environment`, `region`, `instance_id`, and `commit_sha`;
- a server-generated `request_id`, with `trace_id` and `span_id` when tracing is enabled.

The `http.request.completed` event records duration, method, normalized route, status, outcome, MCP
method/tool, principal kind, tenant/role after authentication, and independent origin, credential,
authentication, request/stream capacity, rate-limit, session lookup, and session capacity outcomes.
A validated client `x-request-id` is retained separately as `client_request_id`; it never replaces
the server ID.
Server errors use severity `ERROR`; successful and client-rejected requests use `INFO`.

Completion occurs when the response body closes, errors, or is cancelled, so duration and capacity
release describe the actual streaming lifecycle. `/health` is logged but not traced.

## Data safety

Logs and spans never include authorization headers, token material, database URLs, request or
response bodies, message content, arbitrary query values, raw session IDs, or exception messages.
Validated sessions are represented by a one-way truncated SHA-256 correlation hash. Routes are from
a closed set, error classes are allowlisted, and operational failures retain only a fixed context
plus that class. String fields pass through credential and URL redaction before output and again
before trace export as defense in depth.

Startup configuration and hosted database contract failures use stable, specific `error_class`
values. Operators can distinguish invalid logging, telemetry, database TLS, hosted authentication,
tenant contract, migration, and runtime-role failures without recording the rejected value or an
exception message.

Do not add free-form user input as a field. New values must have a bounded format and cardinality,
a documented diagnostic purpose, a test proving redaction, and the same safe representation in logs
and traces. Treat observability output as sensitive operational metadata even after redaction.

## OpenTelemetry traces

Tracing is opt-in:

```dotenv
MURMUR_TELEMETRY_ENABLED=1
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://collector.example/v1/traces
MURMUR_TELEMETRY_EXPORT_TIMEOUT_MS=4000
```

You may set `OTEL_EXPORTER_OTLP_ENDPOINT` instead; Murmur appends `/v1/traces`. The endpoint must use
HTTPS except for `http://localhost` or `http://127.0.0.1`. Only OTLP HTTP/protobuf is supported.
Export timeout must be an integer from 100 through 5000 milliseconds.

Each non-health request creates a new root `SERVER` span named with the method and normalized route.
Murmur intentionally ignores inbound trace context: an untrusted client cannot forge audit
correlation, attach work to another tenant's trace, or suppress sampling through a remote parent.
Attributes mirror the safe completion fields under the `murmur.*` namespace plus standard HTTP
method, route, status, service, version, and deployment environment attributes.

The exporter queue holds at most 1,024 spans, batches at most 256, and schedules at five-second
intervals. Span attributes, values, events, and links have explicit limits. Provider shutdown is
bounded by the configured export timeout plus 250 milliseconds. A flush failure emits the safe
`telemetry.shutdown.failed` event but does not turn an otherwise graceful service shutdown into an
abnormal exit.

## Deployment context

Set these values explicitly outside Cloud Run when available:

| Variable | Fallback |
| --- | --- |
| `MURMUR_ENVIRONMENT` | `NODE_ENV`, then `development` |
| `MURMUR_REGION` | Cloud region variables, then `unknown` |
| `MURMUR_COMMIT_SHA` | `GITHUB_SHA`, then `unknown` |

Cloud Run supplies revision/host context through `K_REVISION` and `HOSTNAME`. Release version comes
from `package.json`; runtime version comes from Bun.

## Operational diagnosis

Start with `request_id`, then correlate `trace_id` where enabled. Diagnose in admission order:
origin, credential presence/recognition, authentication capacity/result, principal/tenant identity,
request, stream, and rate gates, session lookup/capacity, MCP method/tool, status, and duration. Compare error
rate and latency by normalized route and gate; avoid dashboards that group by request, trace, session,
or tenant identifiers.

A readiness failure or startup error has no request completion event. Inspect the fixed safe startup
message and deployment revision, then validate environment configuration and database reachability.
See [hosted-deployment.md](hosted-deployment.md) for rollout and rollback.
