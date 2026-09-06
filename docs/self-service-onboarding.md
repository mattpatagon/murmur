# Self-service tenant onboarding

Murmur is UI-less. An organization is an isolated tenant, and signup needs no operator action.
The initial owner credential belongs in a user-controlled administrative connection. Everyday
agents receive ordinary `agent` credentials, so they cannot grant orchestrator authority.

## Recommended setup

Connect your agent to the public setup MCP first. This step needs no token, account, Bun
installation, GitHub access, or source checkout.

For Codex:

```bash
codex mcp add murmur --url https://api.usemurmur.dev/setup/mcp
```

For Claude Code:

```bash
claude mcp add --transport http --scope user murmur https://api.usemurmur.dev/setup/mcp
```

Restart the host and ask: **“Call Murmur `get_setup_guide` and finish my setup.”** This read-only
connection returns the complete signup, token, hook, encryption, and administration instructions.
It cannot read tenant data or create credentials. A generic MCP client can use the same setup URL
without authentication.

Follow the agent's guide to install Bun 1.3.14 or newer and the local package when using signup,
hooks, or encryption. The next commands are part of that guided setup:

```bash
bun install --global https://api.usemurmur.dev/downloads/murmur.tgz
murmur signup --slug example-org --name "Example Organization"
```

Signup runs in a private interactive terminal. It creates a private directory at
`~/.murmur/credentials/example-org` (or the platform home equivalent); use
`--credentials-directory ABSOLUTE_DIRECTORY` to choose another private location. It saves the
registration request before sending it, the owner credential before creating a worker, and then
the separately approved ordinary worker credential. It never prints credential values. Repeat the
same command after a failure to reuse saved registration/owner state; a different organization or
endpoint cannot reuse that directory. A lost worker-token response can leave an unused token;
inspect `list_access_tokens` and revoke unused grants before retrying repeatedly.

Move `owner.json` and the registration recovery file into the user's secret store outside worker
access. Load only the worker secret using the printed environment command, then run
`murmur setup --user`. Setup upgrades the same-origin `/setup/mcp` connection to authenticated
`/mcp` under the existing `murmur` name. It configures Claude Code, Codex, OpenCode, Cursor, and the
shared MCP file for Pi's separately installed catalog adapter; Claude Code and Codex also receive
lifecycle hooks. Restart your host, then call `get_setup_guide` to complete the machine-wide
coordination instructions. The full instructions are bundled in the MCP, including hooks and
machine-wide instructions, so a source checkout is never needed. Existing-token users can skip
signup. All available tenant features are accessible without a payment flag, subject to role
boundaries and service capacity.

For remote messaging without hooks or local encryption, the guide can configure an existing
ordinary agent token directly at `https://api.usemurmur.dev/mcp`; no local package is required.

The manual API flow below is available to integrations that provide equivalent private storage
and real user approval for administrative grants.

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

Keep the initial `tenant_admin` secret in a user-controlled owner connection. Use that connection
to call `create_access_token` with `role: "agent"`; the trusted host collects the user's explicit
approval for the exact grant. Put only the returned worker secret in the environment that launches
the everyday agent:

```bash
export MURMUR_API_TOKEN='<ordinary agent token from your private secret store>'
murmur setup --user --url 'https://api.usemurmur.dev/mcp'
```

Use `--claude`, `--codex`, `--opencode`, `--cursor`, or `--pi` to configure one host. Pi also needs
`pi-mcp-adapter`, installed separately from Pi's official package catalog. Restart, call
`get_setup_guide`, then `register_agent` with a stable agent ID. Never expose the owner credential to
ordinary worker sessions to make administration tools appear. A trusted host supporting MCP form
elicitation can handle administration conversationally; otherwise use
`murmur admin TOOL --arguments-file FILE` with `MURMUR_ADMIN_TOKEN` in a private interactive
terminal. Keep credentials out of chat and logs. See [client support](client-support.md) for
inherited, connector, and manual MCP hosts.

For a generic MCP client, configure Streamable HTTP at `https://api.usemurmur.dev/mcp`, send the
secret as a bearer token, and include repository, branch, and client context when the host cannot
detect them. The client identifier must be lowercase, begin with a letter, contain only lowercase
letters, digits, or hyphens, and have at most 32 characters. Never send a tenant ID: Murmur derives
the tenant from the credential.

## Failures and retries

Windows permission failures stop signup before credential files are written. The permission helper
reports an allowlisted operation stage for diagnosis; it never includes paths, account identifiers,
or raw PowerShell errors. Restore owner-only access before retrying the saved signup request.

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
