# Murmur institutional website

The public website explains Murmur's durable inbox, peer coordination, optional orchestration,
deployment choices, setup, and security boundaries. Its design contract is
[DESIGN.md](../DESIGN.md). Every human-facing page is authored as Markdown in
`website/src/pages/`. Astro turns those files into static HTML; React supplements the Markdown
with a setup selector and handoff demonstration. TypeScript and Tailwind CSS provide the bounded
build and presentation layer. The site has no tenant session, credential form, or database access.

The website targets `https://usemurmur.dev` on Cloudflare Pages. The hosted messaging API remains
on Cloud Run at `https://api.usemurmur.dev`; website publication does not replace API deployment.
Murmur is open source under the MIT License, with source at
[github.com/mattpatagon/murmur](https://github.com/mattpatagon/murmur). Public onboarding must work
without a GitHub account or source checkout.

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
release, exact dependency versions, MIT metadata, and the 72-hour minimum release age. The root
dependency gate validates both packages and their workflow pins. Website tooling is not included
in the API image or public MCP executable distribution.
The website scripts run Astro with `bun --bun`; development, checking, building, and previewing
need no separate Node.js installation. Wrangler authentication, project creation, and deployment
require Node.js 22.22.1, which the publication workflow pins separately. The deploy script invokes
Wrangler's JavaScript entry point with Node because authenticated Wrangler commands under Bun were
observed to exit successfully without returning the expected identity output.
Run the repository's required [quality gates](../CONTRIBUTING.md) before requesting review.

The website supports `/`, `/how-it-works`, `/get-started`, `/security`, `/license`, and
`/404.html`. Each rendered page advertises and visibly links to its byte-faithful raw Markdown
source:

| Rendered route | Raw Markdown |
| --- | --- |
| `/` | `/index.md` |
| `/how-it-works` | `/how-it-works.md` |
| `/get-started` | `/get-started.md` |
| `/security` | `/security.md` |
| `/license` | `/license.md` |
| `/404.html` | `/404.html.md` |

Root uses the conventional `/index.md`; every other raw route literally appends `.md` to its
canonical HTML route. Raw responses include their YAML frontmatter, use
`text/markdown; charset=utf-8`, and are marked `noindex`. They are alternate representations, so
only canonical HTML routes appear in the sitemap. Default rendered HTML contains the complete
written guide before React hydrates.
No external font host, analytics service, or authenticated API call is required to read the site.

The client catalog shows only vendor-provided marks for Claude Code, Codex, OpenCode, Cursor, Pi,
Conductor, and Orca. The vendored asset provenance file records each primary source and SHA-256.
Conductor and Orca are described as environments that use the selected agent's effective home and
configuration; isolated agent homes require their own setup. Pi identifies its third-party adapter
from Pi's official package catalog. The Murmur favicon is a separate local brand asset and must
remain linked from every page.

## Build configuration

| Variable | Location | Meaning |
| --- | --- | --- |
| `WEBSITE_SITE_URL` | Optional local environment or GitHub repository variable | Canonical HTTPS origin, default `https://usemurmur.dev`; no path, query, fragment, or credentials |
| `WEBSITE_REVISION` | CI environment; optional local environment | Set from the GitHub commit SHA in CI; full lowercase Git commit hash published in `/version.json`, or `development` for local builds |
| `CLOUDFLARE_ACCOUNT_ID` | Optional GitHub repository variable | Defaults to reviewed account `e357ed8d64611204842123ade5ea838f`, which owns the created `murmur-site` Pages project; override for an intentional account migration |
| `CLOUDFLARE_API_TOKEN` | GitHub repository secret | Account-scoped API token with Cloudflare Pages Edit permission |

The canonical origin controls metadata, social links, the sitemap, and production smoke checks.
Set the same origin and revision for build and artifact verification. A custom domain must already
be attached to the Pages project and publicly reachable before switching `WEBSITE_SITE_URL` to it.

Only the deployment, authentication, and credential-presence steps receive the Cloudflare
credential. Never use an Astro `PUBLIC_` variable for tokens, put a token in a command argument,
or commit credentials.
Local development and pull request validation need no Cloudflare access.

## One-time Cloudflare setup

The existing Direct Upload Pages project is named `murmur-site`, has production branch `main`,
and has the assigned hostname `murmur-site-eip.pages.dev`. The GitHub Actions workflow performs
the build and upload, so a separate Cloudflare Git build is unnecessary. For first project
creation in a new account, use Node.js 22.22.1 and account-scoped credentials supplied through
the local environment:

```text
cd website
node node_modules/wrangler/bin/wrangler.js pages project create murmur-site --production-branch main --force
cd ..
```

Use `--force` only for first Pages project creation; it prevents this Wrangler version from
delegating creation to Workers. It is not required for Pages uploads. A new account may receive a
different Pages hostname; retain the actual assigned hostname in the deployment record.

Create a narrowly scoped API token granting Cloudflare Pages Edit on that account. Add its value
to repository secret `CLOUDFLARE_API_TOKEN`. The workflow already defaults to the reviewed account;
set repository variable `CLOUDFLARE_ACCOUNT_ID` only when intentionally changing that account.
Do not grant DNS-edit permission unless an operator separately needs it
to configure a custom domain. Keep token ownership and rotation in the account's normal access
process.

Attach `usemurmur.dev` to the Pages project and verify DNS/TLS before production smoke checks.
The project record does not prove publication or domain activation. A successful production
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
output. The project's assigned production hostname is `murmur-site-eip.pages.dev`, and the
canonical production target is `https://usemurmur.dev`. Missing credentials fail the production
job with an actionable message. They do not silently skip publication.

Production runs are serialized and are not canceled midway through publication. A newer pull
request revision can cancel an obsolete validation run. Jobs have a 15-minute deadline; live
checks have bounded request timeouts and retries. Workflow permissions grant read-only repository
access, while Cloudflare credentials are limited to upload, authentication, and presence checks.

Before upload, Node runs `wrangler whoami --json` with a 45-second deadline and a 64 KiB response
limit. A typed Zod validator has its own ten-second deadline and requires `loggedIn: true` and the
configured account in `accounts`; empty, malformed, oversized, unauthenticated, or wrong-account
output fails even with exit status zero. CI does not print identity output or raw errors, and the
private temporary response is removed.
CI passes that response path through `WEBSITE_IDENTITY_FILE` to
`bun run scripts/verify-website-identity.ts`; `CLOUDFLARE_ACCOUNT_ID` identifies the required account.

After deployment the job verifies that `/version.json` serves the exact deployed Git revision,
then checks the public pages, `robots.txt`, the `nosniff` response header, proxy transformation
protection, absence of Cloudflare analytics injection, and a real HTTP 404 for an unknown route.
It also fetches all six Markdown alternates, requires their Markdown content type, and compares
each response byte-for-byte with its authored `.md` file. A failed smoke check fails the workflow
even when the upload succeeded. Inspect the deployment before deciding whether to roll it back.
The version marker is served with `Cache-Control: no-store`; the live check bounds its response
to 4 KiB and requests the expected revision explicitly to avoid accepting stale deployment evidence.

The website sends `Cache-Control: public, max-age=0, must-revalidate, no-transform` globally.
Cloudflare documents that [`public, no-transform` prevents automatic analytics injection](https://developers.cloudflare.com/web-analytics/faq/).
This policy applies to website responses without changing zone-wide settings or the hosted API.
Scoped header overrides retain year-long immutable caching for hashed assets and `no-store` for
the revision marker; both retain `no-transform`. The artifact verifier rejects a missing global
transformation policy, and production smoke checks reject injected Cloudflare analytics.

## Verification and maintenance

The artifact verifier checks required pages, document language, title and description, canonical
and Open Graph URLs, the Markdown alternate link, social image and favicon references, one main
landmark and h1, duplicate IDs, internal links and fragments, linked HTML/CSS and client-logo
assets, the component and renderer bundles referenced by Astro's React islands, robots
configuration, and the Pages header artifact. It requires all six bounded UTF-8 Markdown
artifacts, validates their structure and response-header rules, and compares build output with the
authored page bytes. It validates the bounded `/version.json` against the expected revision.
Sitemap coverage counts only pages reachable from the advertised root sitemap or its child
indexes; orphan sitemap files cannot satisfy it.
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
font, browser, and official client-identification assets. It preserves the complete SIL OFL 1.1 notices for DM Sans and IBM Plex
Mono and the installed MIT notices for React, React DOM, Scheduler, Tailwind CSS, Astro, the Astro
React integration, and Vite core. Identical license files are grouped without dropping their
package names or versions. Refresh the notice text and provenance from the installed licenses
when upgrading these packages; keep Murmur's MIT terms separate from their licenses.

For a custom domain, attach it in Cloudflare Pages, verify DNS/TLS, set `WEBSITE_SITE_URL` to its
HTTPS origin, and rerun the Website workflow on `main`. Confirm canonical URLs, social previews,
sitemap URLs, and the production smoke checks use the new origin.

To roll back, select a previously verified production deployment in Cloudflare Pages and use its
rollback action. Verify the public routes and 404 again, then revert the faulty source change
through a reviewed pull request. Rerunning the workflow on the unchanged faulty commit would
publish it again. Rotating the Cloudflare token requires updating the GitHub secret and proving
a new production workflow succeeds; no website source change is required.

Publication verification allows up to 60 seconds for the custom domain to serve the exact new
revision after Wrangler completes its upload. It retries stale successful responses and transient
network failures within that deadline, then verifies public routes, headers, and the real 404.
