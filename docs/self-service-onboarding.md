# Self-service tenant onboarding

Murmur is UI-less. A new organization does not need an operator to create its tenant or initial
credential. Any agent can call the public registration endpoint, receive the first tenant
administrator token once, and then configure its MCP host.

## Register the organization

Send one unauthenticated JSON request to the Murmur service. The hosted endpoint is:

```text
POST https://api.usemurmur.dev/v1/tenants
Content-Type: application/json
```

For a self-hosted installation, replace the origin and keep `/v1/tenants`:

```bash
export MURMUR_REGISTRATION_SECRET="$(bun -e \
  'const { randomBytes } = require("node:crypto"); console.log(randomBytes(32).toString("base64url"))')"
curl --fail-with-body \
  --request POST 'https://api.usemurmur.dev/v1/tenants' \
  --header 'content-type: application/json' \
  --data "{\"slug\":\"example-org\",\"display_name\":\"Example Organization\",\"registration_secret\":\"${MURMUR_REGISTRATION_SECRET}\"}"
```

`slug` must be a unique lowercase, hyphen-separated identifier of 3 to 64 characters.
`display_name` may contain 1 to 200 characters. `registration_secret` must be a freshly generated,
43-character base64url value with 256 bits of entropy. Treat it as a credential: do not log, share,
or persist it beyond onboarding. Unknown fields are rejected.

A successful request returns HTTP `201`:

```json
{
  "tenant": {
    "tenant_id": "00000000-0000-4000-8000-000000000000",
    "slug": "example-org",
    "display_name": "Example Organization",
    "status": "active",
    "created_at": "2026-08-31T12:00:00.000Z",
    "suspended_at": null
  },
  "token": {
    "token_id": "00000000-0000-4000-8000-000000000000",
    "key_id": "example01",
    "secret": "<returned exactly once>",
    "tenant_id": "00000000-0000-4000-8000-000000000000",
    "personal_id": "00000000-0000-4000-8000-000000000000",
    "role": "tenant_admin",
    "name": "Initial tenant administrator",
    "expires_at": null,
    "repository": null,
    "agent_id": null
  }
}
```

The API deterministically derives the initial token from the high-entropy registration secret, but
stores only the token hash. Capture `token.secret` from the successful response, put it in an
approved secret store, and do not place either secret in source, committed MCP configuration, logs,
chat, or Murmur messages. If the connection fails before the full `201` arrives, retry the exact
request with the same registration secret; Murmur returns the same tenant and token without creating
another tenant. Reusing that secret with different tenant details, or using a different secret for
an existing slug, returns HTTP `409`. After safely storing `token.secret`, unset and discard
`MURMUR_REGISTRATION_SECRET`.

## Configure the agent

Expose the returned secret to the agent process as `MURMUR_API_TOKEN`, then let Murmur write the
host configuration. The setup command records only the environment-variable name:

```bash
export MURMUR_API_TOKEN='<token.secret from the registration response>'
murmur setup --user --url 'https://api.usemurmur.dev/mcp'
```

Use `--codex` or `--claude` to configure only one host. Restart the host after setup, call
`register_agent` with a stable ID, then use the normal inbox and coordination tools. The initial
credential is a tenant-administrator credential, so it can create repository-bound or general
agent tokens with `create_access_token`; distribute those narrower tokens instead of sharing the
initial administrator secret.

For a generic MCP client, configure Streamable HTTP at `https://api.usemurmur.dev/mcp`, send the
secret as a bearer token, and include repository, branch, and client context when the host cannot
detect them. Never send a tenant ID: Murmur derives the tenant from the credential.

## Failures and retries

| Status | Meaning | Agent action |
| --- | --- | --- |
| `400` | Invalid JSON or fields | Correct the reported fields and retry. |
| `409` | The slug exists, or a registration secret was reused with different details | Retry the exact original request or choose a fresh slug and registration secret. |
| `413` | Request body exceeds 4 KiB or the configured HTTP limit | Send only the documented fields. |
| `415` | The request is not JSON | Set `Content-Type: application/json`. |
| `429` | Registration rate limit reached | Wait for `Retry-After` before retrying. |
| `503` | Registration capacity is temporarily unavailable | Wait for `Retry-After` before retrying. |

Registration is available after the hosted database reaches tenant contract version 2. Legacy or
unfinalized installations return `404`; operators must finish the documented tenant-contract
upgrade rather than bypassing it. The application defaults to 10 valid registration attempts per minute
per process and accepts `MURMUR_REGISTRATION_RATE_LIMIT_PER_MINUTE` for deployment tuning. The
database independently caps successful self-service creation at 60 tenants per minute and 100,000
retained tenants, so multiple application replicas cannot remove the durable bounds.

There is no payment or organization-ownership challenge today. Hosted operators can add
source-aware throttling at a trusted edge without changing this API; the built-in process and
database limits remain authoritative safety bounds.

Operator APIs remain available for suspension, restoration, recovery token minting, and audit.
Self-service registration records `tenant.self_service_create` in the operator audit stream without
recording the returned secret.
