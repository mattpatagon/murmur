# Public distribution

The source repository remains private. Public installation uses a package built into the existing
hosted service, so users need no GitHub account, repository credential, registry account, or UI.
Begin with the anonymous setup MCP, before creating an organization or obtaining a token:

```text
codex mcp add murmur --url https://api.usemurmur.dev/setup/mcp
```

For Claude Code:

```text
claude mcp add --transport http --scope user murmur https://api.usemurmur.dev/setup/mcp
```

Restart the agent and ask it to call `get_setup_guide`.
This read-only connection supplies the complete signup and configuration instructions.

The agent then guides package installation and signup as needed. Hooks and encryption require the
local package. Install Bun 1.3.14 or newer, then run this same command on Linux, macOS, or Windows:

```text
bun install --global https://api.usemurmur.dev/downloads/murmur.tgz
```

Run `murmur signup --slug YOUR_ORGANIZATION --name 'Your Organization'` in a private terminal,
following its instructions to preserve the owner credential and load the everyday worker token.
With that tenant credential in `MURMUR_API_TOKEN`, run
`murmur setup --user` to configure Codex and Claude Code. Restart the host to activate the hooks.
Setup automatically upgrades the same-origin anonymous `/setup/mcp` entry to `/mcp` under the
same `murmur` name. Conflicting endpoints still require explicit `--replace` after inspection.
The public `GET /install` endpoint provides these bootstrap instructions without authentication.

## Public setup MCP boundary

`/setup/mcp` exposes only the read-only `get_setup_guide` tool. It has no tenant credential, data
tools, administrative operations, private keys, or retained MCP sessions. Adding the connection
cannot create an organization, issue a token, appoint an orchestrator, or read messages. Signup
and authenticated `/mcp` operations occur separately after the user follows the guide.

The endpoint accepts JSON MCP requests through `POST`; other methods return `405`, and other
media types return `415`. Requests follow the configured origin policy. Bodies are limited to
8,192 bytes with a five-second application read deadline; malformed or stalled bodies reaching
that reader return a fixed `400` response. The [native HTTP listener](node-http-transport.md)
rejects declared or streamed byte overflow with `413` before application parsing; its shared ingress
capacity and outer upload deadline can return `503` and `408`. Responses have a 30-second deadline
and release request capacity on completion, cancellation, or failure.

Each process permits at most 600 setup requests per minute, with `429` and `Retry-After: 60` when
that limit is reached. Setup shares the global request-capacity gate, including its per-principal
bound, and leaves one global slot reserved for authenticated MCP. Capacity saturation returns
`503` with `Retry-After: 1`. The setup application closes after each request, so anonymous clients
cannot accumulate persistent sessions or subscriptions.

## Artifact contents

The package contains exactly four minified JavaScript entry bundles (`murmur`, `murmur-hook`,
`murmur-e2ee-proxy`, `murmur-mcp`), a package manifest, a short README, the complete Murmur license,
and third-party license notices. Dependencies are bundled. No source tree, source maps, tests,
credentials, repository configuration, install script, or development dependencies are distributed.
Executable JavaScript remains inspectable; private repository access is not granted by installation.

The runtime retains Murmur's four-part product version. The distribution manifest converts it to
standard package semver (`1.2.3.4` becomes `1.2.3-build.4`) and records the original product version
and exact source revision separately.

## Build and release contract

`bun run build:distribution` requires `MURMUR_RELEASE_REVISION` containing the reviewed 40-character
source revision. It creates `dist/public/murmur.tgz` and `dist/public/release.json`. Docker performs
the same build from its checked-out source and accepts the revision through a build argument.
The deploy workflow supplies its exact `GITHUB_SHA`; the application startup revision must match.

`MURMUR_DISTRIBUTION_DIRECTORY` selects an absolute local artifact directory; Docker sets it to
`/app/dist/public`. With release metadata available, startup rejects invalid files, symlinks,
size overflow, checksum drift, or a version/revision mismatch. No directory means downloads are
unavailable. An endpoint without release metadata returns a safe `503` for package requests.

`GET` and `HEAD` accept only `/downloads/murmur.tgz` and the exact deployed path
`/downloads/murmur-VERSION-REVISION.tgz`. Other filenames return `404`; other methods return `405`.
The canonical filename is never cached. The pinned filename has immutable cache headers and a
SHA-256 ETag. A server stores only its current release; download a pinned release while it is
deployed, or retain the tarball for a later offline reinstall. A revision that is no longer served
returns `404`, never a different artifact.

Each process retains at most 16 MiB of package bytes, permits eight concurrent package streams,
allows 120 downloads per minute, and ends a stream after 30 seconds. Saturation returns `429`
with `Retry-After: 60`. Streams release their slots after completion, cancellation, or deadline.
Download logs use one fixed route label and never record supplied paths or credentials.

`bun run test:distribution` builds and installs the artifact in temporary directories, then tests
CLI help, both hosts' setup, hook loading, the encryption proxy dependency graph, native encrypted
key generation, and local SQLite MCP registration plus the setup guide. CI runs it on Linux,
macOS, and Windows; it requires no hosted account or database.

After deployment, verify that a credential-free MCP client can initialize `/setup/mcp`, discover
only `get_setup_guide`, and read the guide. Also verify `/install`, `/version`, and the canonical
download, then install the downloaded tarball in an isolated directory. Confirm that its embedded
source revision matches `/version` before announcing the release.
