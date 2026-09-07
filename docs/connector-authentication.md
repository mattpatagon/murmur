# Connector authentication

Murmur exposes an OAuth 2.1 compatibility flow for MCP hosts that require OAuth configuration even
when the resource server already uses a fixed bearer credential. It is designed for ChatGPT's
connector form and the equivalent observed Grok form. Grok's public documentation does not define
that form as a stable contract, so Grok compatibility is verified against the observed standard
authorization-code fields rather than claimed as a vendor guarantee.

## Hosted setup

First, use an authenticated tenant-administrator Murmur client to call `create_access_token` with a
descriptive name, role `agent`, and the narrowest useful `machine`/`repository` bindings. Copy the
returned secret immediately; Murmur returns it once and stores only its SHA-256 hash. A connector's
machine binding is credential scope, not proof that the external service runs on that machine.

Enter these values in the connector:

| Field | Hosted value |
| --- | --- |
| MCP server URL | `https://api.usemurmur.dev/mcp` |
| Client ID | `murmur` |
| Client Secret | The dedicated Murmur agent-token secret |
| Authorization endpoint | `https://api.usemurmur.dev/oauth/authorize` |
| Token endpoint | `https://api.usemurmur.dev/oauth/token` |
| Scope | `murmur` |
| Token authentication | `client_secret_basic` (preferred) or `client_secret_post` |

The Client Secret field may be labeled optional by the host, but it is required by Murmur. Never
select `none (PKCE only)`, put the token in Client ID, or append it to a URL. ChatGPT can use its
stable `https://chatgpt.com/connector_platform_oauth_redirect` callback. Murmur also allows the
observed `https://grok.com/oauth/callback` callback by default.

Connector hosts cannot set Murmur's normal repository, branch, and client headers. When sending a
message, broadcast, or feedback, supply `context.repository`, `context.branch`, and
`context.client: "connector"` in the tool call. `connector` is intentionally generic: the reused
bearer token does not securely identify a later request as ChatGPT or Grok, and caller-declared
context is informational rather than an authorization input. Credential-bound tenant, personal,
machine, repository, role, and orchestrator scope remain authoritative.

## Flow and security properties

Murmur publishes RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata.
Hosted deployments set `MURMUR_PUBLIC_ORIGIN` to their canonical HTTPS origin. Discovery, issuer,
resource, challenge, and authorization-code bindings use only that configured value, never an
inbound `Host` or forwarding header. Non-loopback deployments without it fail closed.
The authorization endpoint accepts only the fixed client ID, scope, MCP resource, an exactly
allowlisted HTTPS redirect URI, response type `code`, and an S256 PKCE challenge. It returns a
random authorization code without handling or storing the Murmur credential.

Authorization codes are stored only by SHA-256 digest in process memory. They expire after five
minutes, are limited to 256 outstanding codes, bind the client, issuer, redirect, resource, scope,
and PKCE challenge, and are consumed atomically after every binding validates. A restart discards
them; the connector can safely restart authorization. This matches the hosted deployment's current
single-instance session architecture. Public OAuth requests share bounded HTTP capacity while
reserving at least one slot for authenticated MCP traffic. Authorization issuance is globally rate
limited below the configured code capacity for every live expiry window, so anonymous requests
cannot fill the pool under the default limits. The hard configuration maxima are ten minutes and
4,096 codes.

The token endpoint accepts `client_secret_basic` and `client_secret_post`, validates the secret
through Murmur's existing bounded, constant-time tenant authenticator, and rejects operator and
bootstrap credentials. It returns the same secret as a Bearer access token, not a broader or
longer-lived derivative. No refresh token is issued. Existing expiry, suspension, rotation, and
revocation therefore apply immediately, and token revocation closes matching live MCP sessions.
Failures use fixed OAuth errors and never include credentials, message content, database details,
or internal exceptions.

## Self-hosted configuration

Use the same field layout with the self-hosted HTTPS origin. If a connector supplies a different
callback, add its exact HTTPS URL to the comma-separated
`MURMUR_OAUTH_ALLOWED_REDIRECT_URIS`. Values with credentials, query strings, fragments, or plain
HTTP are rejected. ChatGPT and the observed Grok callback remain allowed when additional values are
configured.

Set `MURMUR_PUBLIC_ORIGIN` to the exact external HTTPS origin, with no path, query, fragment, or
credentials. The optional limits are:

- `MURMUR_OAUTH_AUTHORIZATION_CODE_LIFETIME_MS` (default `300000`, maximum `600000`)
- `MURMUR_OAUTH_AUTHORIZATION_RATE_LIMIT_PER_MINUTE` (default `30`)
- `MURMUR_OAUTH_MAX_AUTHORIZATION_CODES` (default `256`, maximum `4096`)

Keep the service behind HTTPS. Do not add OAuth endpoints to a public allowlist proxy while
blocking `/.well-known/oauth-protected-resource/mcp` or
`/.well-known/oauth-authorization-server`; connector discovery depends on both metadata routes.
