# Platform support

Murmur supports current GitHub-hosted Linux/Ubuntu, macOS, and Windows environments with Bun 1.3.14
or newer. The portable surface includes package installation, strict verification, local SQLite,
configuration for Claude Code, Codex, OpenCode, Cursor, and Pi's MCP adapter, stdio package entry
points, HTTP logic, and production builds.

## CI contract

Every pull request runs `bun install --frozen-lockfile`, `bun run website:install`, `bun run verify`,
`bun run test:portability`, `bun run build`, and `bun run build:http` on Ubuntu, macOS, and Windows.
Tests run from the source checkout; CI no longer installs a separate tarball for verification.
Ubuntu also runs `bun run test` for the environment-independent contributor suite.
Ubuntu additionally runs PostgreSQL 17, TLS, RLS, populated upgrades, hosted integration, and the
authoritative coverage gate. It also starts Murmur once on the runner and once in a clean Linux Bun
container, then proves bidirectional MCP delivery through the shared PostgreSQL service. Linux-only
deployment scripts are separately exercised by CI and the production workflow. The Linux gate also
runs revision-preservation regressions with Bash and jq against synthetic command responses; these
tests never contact a cloud account and are not a shell dependency of portable test gates.

The portability gate exercises production-stream observation, real SDK reconnect with in-memory
SQLite, targeted cleanup, and log-verifier subprocess deadlines using injected local fixtures.
These tests need no cloud credentials, live deployment, or installed Google Cloud CLI.

The Ubuntu `production-image` CI job builds the production Docker image, then runs
`scripts/verify-production-image.ts` inside a network-disabled, read-only container. It verifies both
reviewed SDK declaration patches, an SDK runtime import, and the public distribution's version,
revision, byte size, and SHA-256 digest. This checks the production dependency installation
independently of the runner's development tools.

Platform support means a change cannot merge when a matrix job fails. It does not mean every
operator convenience script is portable.

The portability gate includes real localhost [native HTTP transport](node-http-transport.md)
tests, bounded ingress/output tests, and request-ID lifetime regressions. The same opaque-byte
staging implementation runs on Windows, macOS, and Linux without relying on native input pause.
Portable PostgreSQL-driver recordings also check fresh expiry probes, transaction rollback and
cleanup ordering without requiring a database or shell; real PostgreSQL verification remains in
the Linux hosted gate.
Managed hosting relies on Cloud Run's frontend to terminate external connections; a self-hosted
public listener needs the equivalent edge protections documented by the transport contract.

## Entry points

The public package exposes `murmur`, `murmur-hook`, `murmur-e2ee-proxy`, and `murmur-mcp` as bundled
Bun JavaScript executables. Install from the public hosted tarball on every supported operating
system; no source checkout or GitHub account is required. Repository entry points remain TypeScript.
See [public distribution](public-distribution.md) for artifact contents and release verification.

`scripts/murmur-mcp` is a POSIX repository convenience launcher. It adds macOS Keychain and common
Bun-path discovery before starting the same stdio server. It is not the Windows entry point. Shell
scripts under `scripts/deploy/` and hosted verification require Linux/macOS-compatible shell tools
and are intentionally confined to Linux CI and deployment.

## Paths and configuration

Murmur uses platform path APIs and writes atomic configuration beside the target file. User-scope
setup resolves:

- Windows from `USERPROFILE` and Windows application directories;
- macOS and Linux from `HOME` and each managed client's documented user configuration layout;
- explicit `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and hook executable overrides when supplied.

The setup command validates every selected output before writing any file, preserves unrelated
settings, and stores the name `MURMUR_API_TOKEN`, never its value. Project configuration contains no
home-directory paths. New configuration files use mode `0600` on macOS and Linux. Windows does not
enforce POSIX mode bits; existing configuration files preserve their current mode, while new files
are written inside the selected user profile and inherit its Windows ACLs. Operators must keep that
profile restricted to the intended account. See `murmur setup --help` before using `--replace`.
Claude Code and Codex receive lifecycle hooks. OpenCode and Cursor receive native MCP entries. Pi
receives the shared configuration used by its separately installed `pi-mcp-adapter`; Pi does not
ship MCP itself. Conductor and Orca inherit the selected underlying agent's configuration. The full
support contract is [client support](client-support.md).

The E2E vault uses the platform application-data directory unless `murmur setup --user --e2ee
--vault-path PATH` selects an absolute file inside a dedicated non-root directory. Setup passes
that canonical path to both the proxy and lifecycle hooks. Linux and macOS create the directory as
`0700`, the SQLite file as `0600`, and protect WAL/SHM sidecars before use. Windows applies an
owner-only `icacls` ACL to the directory and database file and rejects an unavailable or malformed
account identity. Private vaults are endpoint state, not portable configuration: do not copy them
between machines or include them in repository backups, support bundles, or CI artifacts.

## Local development

The commands are identical in Bash, zsh, and PowerShell:

```text
bun install --frozen-lockfile
bun run website:install
bun run verify
bun run test:portability
bun run build
bun run build:http
```

Environment-variable syntax differs by shell. In PowerShell, use
`$env:MURMUR_API_TOKEN = "..."`; in POSIX shells, use `export MURMUR_API_TOKEN='...'`. Never commit a
`.env` file.

ChatGPT and Grok use the hosted HTTPS OAuth compatibility endpoints and require no local launcher,
shell, or filesystem path. Self-hosted connector callback additions are exact HTTPS URLs in
`MURMUR_OAUTH_ALLOWED_REDIRECT_URIS`, whose comma-separated syntax is the same on every platform.
Non-loopback deployments also set the platform-independent `MURMUR_PUBLIC_ORIGIN` to one canonical
HTTPS origin.

SQLite local mode needs no external service. PostgreSQL integration requires a reachable PostgreSQL
17 instance and TLS configuration; the authoritative scripts additionally require Bash, Docker, and
PostgreSQL client tools on Linux. Cloud Run deployment requires the tools listed in
[hosted-deployment.md](hosted-deployment.md).

The host-to-container gate rewrites only loopback database hostnames to Docker's runner gateway and
adds that gateway explicitly when the container launches. Remote PostgreSQL hostnames are preserved
unchanged.

## Institutional website

The Astro, React, TypeScript, and Tailwind site in `website/` has its own exact dependency pins
and frozen lockfile. Its check/build commands use Bun and portable platform APIs on all three
operating systems. The repository verification gate includes Astro and frontend source checks.
The dedicated Ubuntu website workflow builds static pages, validates links and assets, and deploys
verified pushes to `main` automatically to Cloudflare Pages. The MCP service remains on Cloud Run.
Only Wrangler authentication, project creation, and deployment require Node.js 22.22.1; the
publication workflow installs that exact version before checking the authenticated account and
uploading. Astro development and verification remain Bun-only. The canonical website target is
`https://usemurmur.dev`; the existing Pages project hostname is `murmur-site-eip.pages.dev`.
See [website operations](website.md) for required Cloudflare configuration and smoke checks.

## Reporting a platform defect

Include the operating system and version, architecture, Bun version, filesystem type when relevant,
command, safe error text, and a minimal reproduction. Do not attach credentials, database URLs,
message content, home-directory contents, or full production logs. See [SUPPORT.md](../SUPPORT.md).
