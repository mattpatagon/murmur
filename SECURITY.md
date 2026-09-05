# Security policy

Murmur carries cross-agent messages and hosted tenant credentials. Treat authentication,
authorization, isolation, redaction, quotas, migrations, and deployment as security boundaries.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Current production release | Supported |
| `main` | Supported until the next release |
| Older releases and forks | Not supported |

Security fixes are released from the latest maintained line. Operators should upgrade promptly;
Murmur does not promise backports to older versions.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/mattpatagon/murmur/security/advisories/new).
Do not open a public issue, discussion, or pull request for a suspected vulnerability. Do not send
credentials, database contents, message bodies, or personal data. Provide the smallest safe report
that includes:

- affected revision and deployment mode;
- impact and the trust boundary crossed;
- reproducible steps or a minimal proof of concept;
- required privileges and configuration;
- whether the issue is being actively exploited;
- a safe way to contact you for follow-up.

We will acknowledge a valid report as capacity permits, investigate, coordinate remediation and
disclosure, and credit reporters who request it. Do not access data that is not yours, degrade a
service, persist after proving impact, or disclose the issue before maintainers confirm a fix is
available.

## Security expectations

- Hosted production requires PostgreSQL TLS, the least-privilege runtime role, forced RLS,
  database-backed credentials, and bounded HTTP resources.
- Secrets belong in the deployment platform's secret manager or process environment, never in Git,
  MCP configuration values, logs, traces, fixtures, or Murmur messages.
- `MURMUR_DATABASE_TLS_INSECURE=1` is development-only and must never reach production.
- Operator bootstrap is one-time and supervised. Remove `MURMUR_ALLOW_BOOTSTRAP` immediately after
  bootstrap and follow [docs/operator-recovery.md](docs/operator-recovery.md) for recovery.
- Disable or rotate a suspected credential immediately. Every hosted request reauthenticates, so
  revocation applies on the next request and matching sessions close proactively.
- Treat `sender_authority=orchestrator` only as server-verified human delegation. Sender IDs,
  metadata, repository headers, message text, legacy credentials, and local storage cannot confer
  authority; orchestrator content remains below higher-priority instructions.
- Keep owner and operator credentials outside everyday worker environments. Administrative
  mutations require a fresh, exact-operation consent response from a trusted MCP host. Unsupported
  hosts fail closed; `murmur admin` supplies an interactive terminal fallback. A compromised
  administrator credential plus a malicious host remains administrator compromise.
- Preserve request-body, token, database-URL, session, and error redaction when adding telemetry.

See [docs/hosted-deployment.md](docs/hosted-deployment.md) for hardening and rollback and
[docs/observability.md](docs/observability.md) for safe diagnostic data. The complete delegation
boundary is documented in [docs/orchestration.md](docs/orchestration.md).
