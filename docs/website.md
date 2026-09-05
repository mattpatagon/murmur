# Murmur institutional website

The public website explains what Murmur does, its durable inbox model, its audiences, setup,
and security boundaries. Its design contract is [DESIGN.md](../DESIGN.md). It lives in `website/`
and uses Astro for static HTML, React for the setup selector and handoff demonstration,
TypeScript, and Tailwind CSS. It has no tenant session, credential form, or database access.

Cloudflare Pages serves the website. The hosted messaging API remains on Cloud Run at
`https://api.usemurmur.dev`; website publication does not replace API deployment. The source
repository is private. Public onboarding must work without a GitHub account or repository access.
Murmur is source-available under the Elastic License 2.0, not an open-source license.

## Local development

Run these commands from the repository root with the pinned Bun version in `package.json`:

```text
bun install --frozen-lockfile
bun install --cwd website --frozen-lockfile
bun run website:dev
bun run website:check
bun run website:build
bun run website:test
```

The Astro build writes `website/dist/`. `website:test` audits that existing build; rebuild after
changing a page or asset. The website uses an isolated `website/package.json`, `website/bun.lock`,
and `website/bunfig.toml`. Its Astro checker needs TypeScript's JavaScript API, so the website pins
TypeScript 6.0.3 while the MCP runtime retains TypeScript 7.0.2. Both packages pin the same Bun
release, exact dependency versions, ELv2 metadata, and the 72-hour minimum release age. The root
dependency gate validates both packages and their workflow pins. Website tooling is not included
in the API image or public MCP executable distribution.
The website scripts explicitly run Astro and Wrangler with `bun --bun`, so they do not require
a separate Node.js installation. Use the package scripts to preserve that runtime selection.
Run the repository's required [quality gates](../CONTRIBUTING.md) before requesting review.

The website supports `/`, `/how-it-works/`, `/get-started/`, `/security/`, `/license/`, and `/404.html`.
The default rendered HTML contains useful setup instructions and a readable handoff example
before React hydrates. No external font host, analytics service, or authenticated API call is
required to read the site.

## Build configuration

| Variable | Location | Meaning |
| --- | --- | --- |
| `WEBSITE_SITE_URL` | Optional local environment or GitHub repository variable | Canonical HTTPS origin, default `https://murmur-site.pages.dev`; no path, query, fragment, or credentials |
| `WEBSITE_REVISION` | CI environment; optional local environment | Set from the GitHub commit SHA in CI; full lowercase Git commit hash published in `/version.json`, or `development` for local builds |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub repository variable | Cloudflare account that owns the `murmur-site` Pages project |
| `CLOUDFLARE_API_TOKEN` | GitHub repository secret | Account-scoped API token with Cloudflare Pages Edit permission |

The canonical origin controls metadata, social links, the sitemap, and production smoke checks.
Set the same origin and revision for build and artifact verification. A custom domain must already
be attached to the Pages project and publicly reachable before switching `WEBSITE_SITE_URL` to it.

Only the deployment and credential-presence steps receive the Cloudflare credential. Never use an
Astro `PUBLIC_` variable for tokens, put a token in a command argument, or commit credentials.
Local development and pull request validation need no Cloudflare access.

## One-time Cloudflare setup

An account administrator creates a Pages project named `murmur-site` with production branch
`main`, using Direct Upload. The GitHub Actions workflow performs the build and upload, so a
separate Cloudflare Git build is unnecessary. With account-scoped credentials supplied through
the local environment, the pinned CLI can create the project:

```text
cd website
bun --bun wrangler pages project create murmur-site --production-branch main
cd ..
```

Create a narrowly scoped API token granting Cloudflare Pages Edit on that account. Add its value
to repository secret `CLOUDFLARE_API_TOKEN`, and add the account ID as repository variable
`CLOUDFLARE_ACCOUNT_ID`. Do not grant DNS-edit permission unless an operator separately needs it
to configure a custom domain. Keep token ownership and rotation in the account's normal access
process.

Creating the workflow does not prove these account settings exist. A successful production
workflow and a live response from the configured origin establish that setup is complete.

## Automatic publication

[The Website workflow](../.github/workflows/website.yml) runs on pull requests targeting `main`,
pushes to `main`, and manual dispatch. It installs both frozen lockfiles, checks the source,
tests the artifact verifier, builds Astro, and audits the static output. Pull requests validate
without deploying. A successful push or manual run on `main` uploads that verified output to
Cloudflare Pages with the Git commit hash. Manual runs on other branches only validate.

The workflow invokes the website's upload script:

```text
bun run --cwd website deploy --branch=main
```

The workflow also passes `--commit-hash` from GitHub's revision. For an operator-triggered release,
prefer manual dispatch on `main`, which builds and verifies the revision before uploading. A local
production upload must set `WEBSITE_REVISION` to the intended full Git hash for both build and
verification, then pass that same hash with `--commit-hash`; a default local build identifies
itself as `development`.

Each Pages deployment identifies its revision and has a unique deployment URL in the command
output; `murmur-site.pages.dev`
points to the current production deployment. Missing credentials fail the production job with
an actionable message. They do not silently skip publication.

Production runs are serialized and are not canceled midway through publication. A newer pull
request revision can cancel an obsolete validation run. Jobs have a 15-minute deadline; live
checks have bounded request timeouts and retries. Workflow permissions grant read-only repository
access, while Cloudflare credentials are limited to the upload step and its presence check.

After deployment the job verifies that `/version.json` serves the exact deployed Git revision,
then checks the public pages, `robots.txt`, the `nosniff` response header,
and a real HTTP 404 for an unknown route. A failed smoke check fails the workflow even when the
upload succeeded. Inspect the deployment before deciding whether to roll it back.
The version marker is served with `Cache-Control: no-store`; the live check bounds its response
to 4 KiB and requests the expected revision explicitly to avoid accepting stale deployment evidence.

## Verification and maintenance

The artifact verifier checks required pages, document language, title and description, canonical
and Open Graph URLs, social image references, one main landmark and h1, duplicate IDs, internal
links and fragments, linked HTML/CSS assets, the component and renderer bundles referenced by
Astro's React islands, robots configuration, and the Pages header artifact. It validates the
bounded `/version.json` against the expected revision. Sitemap coverage counts only pages reachable
from the advertised root sitemap or its child indexes; orphan sitemap files cannot satisfy it.
The sitemap traversal rejects malformed XML, cycles, external origins, and excessive depth,
files, bytes, or locations, without resolving external entities or making network requests.
It rejects builds over 100 KiB of total gzip JavaScript or 250 KiB of font assets.
Counting all JavaScript is deliberately conservative relative to the initial-load
budget. It bounds the file census and rejects symbolic links.

The verifier is offline: it does not claim external links work, emulate interactions, establish
accessibility conformance, or prove deployed status codes. Before release, use the gstack browse
skill to inspect desktop/mobile layouts, keyboard controls, the setup selector, copy success and
failure, handoff steps, console errors, and response headers. Keep [DESIGN.md](../DESIGN.md) current
when the visual system or interaction contract changes.

The public license page links to
[third-party-notices.txt](../website/public/third-party-notices.txt), which accompanies the deployed
font and browser assets. It preserves the complete SIL OFL 1.1 notices for DM Sans and IBM Plex
Mono and the installed MIT notices for React, React DOM, Scheduler, Tailwind CSS, Astro, the Astro
React integration, and Vite core. Identical license files are grouped without dropping their
package names or versions. Refresh the notice text and provenance from the installed licenses
when upgrading these packages; keep Murmur's ELv2 terms separate from their licenses.

For a custom domain, attach it in Cloudflare Pages, verify DNS/TLS, set `WEBSITE_SITE_URL` to its
HTTPS origin, and rerun the Website workflow on `main`. Confirm canonical URLs, social previews,
sitemap URLs, and the production smoke checks use the new origin.

To roll back, select a previously verified production deployment in Cloudflare Pages and use its
rollback action. Verify the public routes and 404 again, then revert the faulty source change
through a reviewed pull request. Rerunning the workflow on the unchanged faulty commit would
publish it again. Rotating the Cloudflare token requires updating the GitHub secret and proving
a new production workflow succeeds; no website source change is required.
