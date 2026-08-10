# Platform support

Murmur supports current GitHub-hosted Linux/Ubuntu, macOS, and Windows environments with Bun 1.3.11
or newer. The portable surface includes package installation, strict verification, local SQLite,
configuration for Codex and Claude, stdio package entry points, HTTP logic, and production builds.

## CI contract

Every pull request runs `bun install --frozen-lockfile`, `bun run verify`,
`bun run test:portability`, `bun run build`, and `bun run build:http` on Ubuntu, macOS, and Windows.
Ubuntu additionally runs PostgreSQL 17, TLS, RLS, populated upgrades, hosted integration, and the
authoritative coverage gate. It also starts Murmur once on the runner and once in a clean Linux Bun
container, then proves bidirectional MCP delivery through the shared PostgreSQL service. Linux-only
deployment scripts are separately exercised by CI and the production workflow.

Platform support means a change cannot merge when a matrix job fails. It does not mean every
operator convenience script is portable.

## Entry points

The package exposes `murmur`, `murmur-hook`, and `murmur-mcp` directly as Bun TypeScript executables;
these are the portable entry points. Use them from any operating system after global installation or
through an absolute Bun command configured by the MCP host.

`scripts/murmur-mcp` is a POSIX repository convenience launcher. It adds macOS Keychain and common
Bun-path discovery before starting the same stdio server. It is not the Windows entry point. Shell
scripts under `scripts/deploy/` and hosted verification require Linux/macOS-compatible shell tools
and are intentionally confined to Linux CI and deployment.

## Paths and configuration

Murmur uses platform path APIs and writes atomic configuration beside the target file. User-scope
setup resolves:

- Windows from `USERPROFILE` and Windows application directories;
- macOS and Linux from `HOME` and each client's documented user configuration layout;
- explicit `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and hook executable overrides when supplied.

The setup command validates every selected output before writing any file, preserves unrelated
settings, and stores the name `MURMUR_API_TOKEN`, never its value. Project configuration contains no
home-directory paths. New configuration files use mode `0600` on macOS and Linux. Windows does not
enforce POSIX mode bits; existing configuration files preserve their current mode, while new files
are written inside the selected user profile and inherit its Windows ACLs. Operators must keep that
profile restricted to the intended account. See `murmur setup --help` before using `--replace`.

The E2E vault uses the platform application-data directory unless `--vault-path` selects an
absolute file inside a dedicated non-root directory. Linux and macOS create the directory as
`0700`, the SQLite file as `0600`, and protect WAL/SHM sidecars before use. Windows applies an
owner-only `icacls` ACL to the directory and database file and rejects an unavailable or malformed
account identity. Private vaults are endpoint state, not portable configuration: do not copy them
between machines or include them in repository backups, support bundles, or CI artifacts.

## Local development

The commands are identical in Bash, zsh, and PowerShell:

```text
bun install --frozen-lockfile
bun run verify
bun run test:portability
bun run build
bun run build:http
```

Environment-variable syntax differs by shell. In PowerShell, use
`$env:MURMUR_API_TOKEN = "..."`; in POSIX shells, use `export MURMUR_API_TOKEN='...'`. Never commit a
`.env` file.

SQLite local mode needs no external service. PostgreSQL integration requires a reachable PostgreSQL
17 instance and TLS configuration; the authoritative scripts additionally require Bash, Docker, and
PostgreSQL client tools on Linux. Cloud Run deployment requires the tools listed in
[hosted-deployment.md](hosted-deployment.md).

The host-to-container gate rewrites only loopback database hostnames to Docker's runner gateway and
adds that gateway explicitly when the container launches. Remote PostgreSQL hostnames are preserved
unchanged.

## Reporting a platform defect

Include the operating system and version, architecture, Bun version, filesystem type when relevant,
command, safe error text, and a minimal reproduction. Do not attach credentials, database URLs,
message content, home-directory contents, or full production logs. See [SUPPORT.md](../SUPPORT.md).
