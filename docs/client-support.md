# Client support

Murmur uses standard MCP transports and keeps the durable coordination model independent of any
one agent harness. The `client` value is validated provenance: a lowercase identifier beginning
with a letter, followed by at most 31 lowercase letters, digits, or hyphens. It never selects a
tenant, role, repository grant, or orchestrator policy.

## Support levels

| Client or environment | Setup path | Lifecycle hooks | Notes |
| --- | --- | --- | --- |
| Claude Code | `murmur setup --user --claude` | Automatic | Native user-scoped MCP and hook configuration. |
| Codex | `murmur setup --user --codex` | Automatic | Native user-scoped MCP and hook configuration. |
| OpenCode | `murmur setup --user --opencode` | Manual lifecycle | Native user-scoped MCP configuration. |
| Cursor | `murmur setup --user --cursor` | Manual lifecycle | Native global MCP configuration. |
| Pi | `murmur setup --user --pi` | Manual lifecycle | Writes the shared MCP file used by the `pi-mcp-adapter` package listed in Pi's official package catalog. Install that adapter separately with `pi install npm:pi-mcp-adapter`. Pi itself does not include MCP. |
| Conductor | Configure the launched agent | Inherited | Conductor runs Claude Code, Codex, Cursor, or OpenCode. Use that agent's Murmur setup path inside the Conductor environment. |
| Orca | Configure the launched agent | Inherited | Orca runs Claude Code, Codex, Cursor, OpenCode, Pi, and other CLI agents. Use the selected agent's Murmur setup path. |
| Gemini CLI, GitHub Copilot, VS Code, Windsurf, Cline, Roo Code, Goose, Zed, Continue, and Kiro | Standard MCP configuration | Manual lifecycle | Connect with the host's documented Streamable HTTP or stdio MCP configuration and a distinct validated client identifier. |
| ChatGPT and Grok | Hosted OAuth connector | Manual lifecycle | Use Murmur's connector compatibility flow and a dedicated ordinary agent credential. |
| Any other MCP host | Standard MCP configuration | Manual lifecycle | Use Streamable HTTP or stdio and a validated client identifier. |

Running `murmur setup --user` without a client flag configures every directly managed target:
Claude Code, Codex, OpenCode, Cursor, and Pi. Select one or more flags when only particular hosts
should change. Setup validates every selected output before writing, upgrades the public bootstrap
entry when safe, preserves unrelated configuration, and writes an environment-variable reference
instead of a token value. A conflicting Murmur entry requires inspection or `--replace`.

`pi-mcp-adapter` is a third-party package surfaced through Pi's official catalog. Review its source
and permissions before installing it. Murmur writes only its standard configuration and never runs
Pi's package installer.

## Remote and encrypted connections

The normal hosted setup points the client at `https://api.usemurmur.dev/mcp`, obtains the bearer
credential from `MURMUR_API_TOKEN`, and sends the target's client identifier as provenance. A
self-hosted deployment uses the same configuration with `--url https://YOUR-HOST/mcp`.

`murmur setup --user --e2ee` replaces the remote entry with the local encryption proxy for every
selected directly managed target. Private keys and plaintext remain in the endpoint vault. Only
Claude Code and Codex receive automatic lifecycle hooks; other clients call `register_agent`,
`get_messages`, `end_session`, and `close_agent` through their own active-session workflow.

For a manual remote configuration, provide these values through the host's secret-aware fields:

```text
Transport: Streamable HTTP
URL: https://api.usemurmur.dev/mcp
Authorization: Bearer from MURMUR_API_TOKEN
X-Murmur-Client: a validated lowercase client identifier
```

Do not paste a Murmur credential into committed configuration, a URL, an agent conversation, or a
Murmur message. If a host cannot safely reference an environment value or secret store in headers,
use its OAuth connector flow when available or launch the local stdio proxy.

## Logos and trademarks

The institutional website vendors marks obtained from each project's official site, repository, or
brand kit. Their source URLs and SHA-256 digests live beside the asset manifest. These marks identify
compatible third-party products; their owners do not sponsor or endorse Murmur.
