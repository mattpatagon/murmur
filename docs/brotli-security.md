# Brotli decoder security rollout

[CVE-2026-111497](https://patchtheplanet.org/brotli) affects applications that decode
attacker-controlled Brotli data. Crafted input can corrupt memory and permit remote code
execution. Updating a JavaScript package lockfile alone does not replace the decoder embedded
in a runtime.

## Patched runtime requirements

- Bun 1.4.4 includes Brotli 1.2.1. Both production Docker stages, contributor and website
  toolchains, CI, deployment, production smoke, and Linux container tests use this exact release.
  Local hooks, setup helpers, encryption proxies, and bundled clients require Bun 1.4.4 or newer.
- Website publication uses Node.js 22.23.4, the fixed release on the existing Node 22 line.
  Wrangler runs under that Node binary. Website development, checks, and builds run under Bun.

The [Bun release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) and
[Node.js release](https://nodejs.org/en/blog/release/v22.23.4) identify the selected versions.
Keep dependency versions, both lockfiles, and the 72-hour dependency quarantine unchanged during
this runtime rollout. The existing Bun type declarations remain compatible with the APIs used.

The production stream verifier accepts cancellation rejected with the exact reason of its
already-aborted request. Bun 1.4.4 exposes that terminal state during native SSE cleanup.
Unrelated aborts, cancellation errors, cleanup deadlines, and locked-reader failures still fail.

## Service inventory

The hosted HTTP/MCP service and distributed local clients use Bun. Outbound HTTP clients can
decode compressed responses before application response-size limits run, so those limits do
not replace the runtime patch. Ingress reads bounded opaque request bytes and does not install
a Brotli decompression middleware. This repository configures no Envoy or Istio decompressor.

The website deploys static Astro output to Cloudflare Pages. Wrangler's workerd/Miniflare and
Astro's Sharp/libvips dependencies are build/development tools, not deployed application services.
Their native libraries are independent of Bun and Node; do not treat the runtime update as
evidence that every native decoder is patched. Reassess those tools before processing untrusted
compressed files or running a development proxy against untrusted origins. Cloudflare-managed
edge runtimes and any operator-managed proxies require vendor verification separately.

## Rollout and verification

1. Build fresh API images from the updated Dockerfile and deploy through the normal production
   workflow. Restart every serving replica; an old running process keeps its old decoder.
2. Publish the website through its updated workflow. Rebuild downloadable clients and restart
   local hooks, proxies, workers, and agent sessions after upgrading their installed Bun binary.
3. Confirm `bun --version` is at least 1.4.4 and `node --version` is at least 22.23.4 on the
   Node 22 line. Check the deployed image/revision, health, and authenticated production smoke;
   a successful source merge alone does not establish that a deployment is patched.
4. Run the existing static, portability, SQLite, PostgreSQL coverage, Linux container,
   distribution, website, and slow-reader checks with the patched runtime. Preserve the HTTP
   transport's cancellation, response lifetime, and memory bounds during the upgrade.

If a deployment cannot update immediately, follow the advisory's temporary mitigation: reject
Brotli before decoding on every incoming request, fetched response, proxy, and file-processing
path. Removing `br` from `Accept-Encoding` or checking headers after automatic decoding is
insufficient. Keep the temporary block until all affected processes have restarted on fixed builds.
