# Hosted deployment

This runbook covers the supported production deployment: GitHub Actions to
Google Cloud Run, with Supabase PostgreSQL and Google Secret Manager. The
committed workflow is the source of truth for sequencing:
`.github/workflows/deploy.yml` runs on every push to `main` and can also be
started manually.

Both production deployment and production-isolation verification execute only for
`refs/heads/main`. Manual dispatches against a branch or tag skip the privileged job before
checkout, workload-identity authentication, or production secret access.

## Service contract

The deployed service exposes:

- `GET /health`, an unauthenticated liveness endpoint that returns a JSON
  `status` of `ok` only after startup has completed.
- `GET /version`, an unauthenticated endpoint that returns the deployed four-part version and exact
  source revision used by upgrade checks.
- `GET /install`, plain-text public installation instructions, and `GET`/`HEAD /downloads/murmur.tgz`
  plus its version-and-revision-pinned path, the public package described in
  [public distribution](public-distribution.md).
- `POST /setup/mcp`, an anonymous, read-only MCP connection exposing only `get_setup_guide`, so
  users can begin before signup or credential configuration. It has bounded request bodies,
  deadlines, rate and capacity gates, and no retained sessions or tenant access.
- `POST /v1/tenants`, an unauthenticated, rate-limited endpoint that atomically
  creates a tenant and returns its initial administrator credential.
- `/mcp`, a public Streamable HTTP endpoint that requires a live Murmur bearer
  token for every MCP request.
- `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server`, public connector discovery metadata.
- `/oauth/authorize` and `/oauth/token`, the bounded authorization-code and existing-token
  compatibility flow for connector hosts.

Cloud Run ingress is public so generic MCP clients can connect. Public ingress
does not bypass Murmur authorization. The initial deployment uses one instance
because MCP sessions and connector authorization codes are in memory. Messages, tenant
credentials, and authorization policy remain durable in PostgreSQL across restarts; a connector
restarts authorization when an ephemeral five-minute code is lost.

Every deployment explicitly sets one vCPU, 512 MiB, service-wide `--max 1`, and revision-level
`--max-instances 1`. The service-wide limit also constrains traffic split across revisions;
revision limits alone do not express that aggregate intent. Do not leave independently reachable
tagged revisions running as additional free capacity. These controls constrain autoscaling, not
the entire provider bill: Cloud Run can briefly exceed its instance maximum during traffic spikes,
and request, network, logging and database charges remain separate. See
[Cloud Run maximum-instance behavior](https://cloud.google.com/run/docs/configuring/max-instances).

Production PostgreSQL connections must use certificate verification. The
runtime mounts the Supabase Server root certificate and connects as the
non-owner, non-superuser, non-`BYPASSRLS` `murmur_app` role. Tenant-qualified
queries and forced row-level security are independent isolation layers.

## Prerequisites

Provision these dependencies before enabling the workflow:

- a Google Cloud project with Cloud Run, Artifact Registry, Secret Manager,
  and Workload Identity Federation enabled;
- a deploy service account trusted by the GitHub repository through Workload
  Identity Federation;
- a separate Cloud Run runtime service account;
- a Supabase PostgreSQL project and its verified Server root certificate;
- a GitHub `production` environment with protected deployment approvals;
- Bun 1.3.14 for manual verification and recovery work.

Restrict the GitHub `production` environment's deployment branches to `main`, and restrict the
Google workload-identity provider to this repository and `assertion.ref == 'refs/heads/main'`.
The committed job condition prevents accidental dispatches; environment and identity-provider
policies independently prevent a modified workflow on another branch from obtaining production
credentials. Verify these settings in the live control planes before enabling deployment.

Do not create or download a long-lived Google service-account key. GitHub
authenticates with short-lived workload identity credentials.

Configure these GitHub Actions repository or environment variables:

| Variable | Meaning |
| --- | --- |
| `GCP_PROJECT_ID` | Google Cloud project ID |
| `GCP_REGION` | Cloud Run and Artifact Registry region |
| `GCP_SERVICE` | Cloud Run service name |
| `GCP_ARTIFACT_REPOSITORY` | Docker Artifact Registry repository |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Workload-identity deploy principal |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Least-privilege Cloud Run principal |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | GitHub OIDC provider resource name |
| `PRODUCTION_URL` | HTTPS service origin, without `/mcp` |

## Secret inventory

All production values live in Google Secret Manager, not GitHub Actions
secrets or repository files.

| Secret | Contents | Readers |
| --- | --- | --- |
| `MURMUR_CI_DATABASE_URL` | Migration-owner URL through the IPv4 session pooler | Deploy identity only |
| `MURMUR_DATABASE_URL` | Versioned direct runtime URL for `murmur_app` | Deploy and runtime identities |
| `MURMUR_DATABASE_CA` | Verified Supabase Server root certificate | Deploy and runtime identities |
| `MURMUR_API_TOKEN` | Existing founding-tenant token used only during adoption | Deploy identity until adoption completes |
| `MURMUR_OPERATOR_TOKEN` | Versioned production operator token | Deploy identity only |

The runtime identity must never read the migration-owner URL or operator token.
After adoption it also loses access to the legacy founding token. The database
stores only SHA-256 token hashes; raw tenant and operator tokens are returned
once and must remain in an approved secret store.

## One-time secret preparation

Create the founding-tenant token only when adopting an existing legacy
deployment. Do not reuse a database password as an API token:

```bash
openssl rand -hex 32 | \
  gcloud secrets create MURMUR_API_TOKEN \
    --replication-policy=automatic \
    --data-file=-
```

Download the Supabase Server root certificate, verify its fingerprint through
an independent dashboard session, and store it as a public trust anchor:

```bash
gcloud secrets create MURMUR_DATABASE_CA \
  --replication-policy=automatic \
  --data-file=./supabase-server-root.crt
```

Create the operator secret container without adding a value. The workflow adds
the first version before committing its hash, which makes interrupted bootstrap
runs resumable:

```bash
export GOOGLE_CLOUD_PROJECT='your-project-id'
export MURMUR_DEPLOY_SERVICE_ACCOUNT_NAME='murmur-github-deploy'
MURMUR_DEPLOY_SERVICE_ACCOUNT="${MURMUR_DEPLOY_SERVICE_ACCOUNT_NAME}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
deploy_member="serviceAccount:${MURMUR_DEPLOY_SERVICE_ACCOUNT}"

gcloud secrets describe MURMUR_OPERATOR_TOKEN \
  --project "$GOOGLE_CLOUD_PROJECT" >/dev/null 2>&1 || \
  gcloud secrets create MURMUR_OPERATOR_TOKEN \
    --project "$GOOGLE_CLOUD_PROJECT" \
    --replication-policy=automatic
```

Grant the deploy identity:

- `roles/secretmanager.secretAccessor` on `MURMUR_CI_DATABASE_URL` and
  `MURMUR_DATABASE_CA`;
- `roles/secretmanager.secretVersionManager` and
  `roles/secretmanager.secretAccessor` on `MURMUR_DATABASE_URL`;
- `roles/secretmanager.viewer`, `roles/secretmanager.secretVersionAdder`, and
  `roles/secretmanager.secretAccessor` on `MURMUR_OPERATOR_TOKEN`;
- `roles/secretmanager.admin` on the retiring `MURMUR_API_TOKEN` only while
  adoption is incomplete.

Grant the runtime identity `roles/secretmanager.secretAccessor` only on
`MURMUR_DATABASE_URL` and `MURMUR_DATABASE_CA`. The workflow performs
non-mutating permission probes before migrations; Secret Manager still
authorizes each rollout operation.

## Automated rollout

The production workflow is serialized with a non-canceling `production`
concurrency group. It performs these phases in order:

1. Check out the merged revision, install exact dependencies, run all local
   verification, test custom-CA TLS, and verify hosted isolation against a
   disposable PostgreSQL 17 service.
2. Authenticate with workload identity, validate secret permissions and the source
   compatibility of retained revisions, install the CA, apply pending migrations,
   and run the shared PostgreSQL suite. Deployment does not invoke global expiry
   pruning; existing retained data and overfull storage ledgers are preserved.
3. Build an image tagged with the Git commit SHA and push it to Artifact
   Registry.
4. Inspect enabled runtime-secret versions. Reuse a valid `murmur_app`
   credential, recover an interrupted credential rotation, or create and apply
   a new random runtime password.
5. Deploy a compatibility revision when legacy adoption is still required,
   atomically bootstrap the first operator if necessary, adopt the founding
   token, and switch to strict multi-tenant authorization.
6. Route all traffic to the current and future latest healthy revision and remove direct revision
   tags, preserving superseded revision definitions. The floating latest target prevents a prior
   exact-revision cutover from pinning later deployments away from traffic. Existing streams can
   finish; traffic routing alone does not prove their writers have drained.
7. Finalize and validate tenant-qualified foreign keys when the database is at
   contract version 1, restart the strict revision at contract version 2, and
   verify health again.
8. Disable superseded runtime database-secret versions only after the final
   revision and tenant contract are healthy.

Every phase fails closed. Credential and adoption state are read from the
database and Secret Manager on each run, so an interrupted workflow resumes
from durable state instead of assuming the previous attempt finished.

Automatic preservation accepts only declared images from the configured artifact
repository whose source commits descend from v0.13.0.0 (`d89d405`) and are ancestors
of the deployment commit. It uses full local Git history and rejects unknown
provenance, unrelated images, and oversized revision inventories before migrations.
Digest-only images require one unambiguous full source-SHA tag from a bounded tag lookup
filtered to that exact registry version. A separate source-tag lookup must resolve to the
deployed digest. Every returned tag must belong to that version and package; 1,001 returned
tags exceed the bound. Missing, ambiguous, truncated, or mismatched metadata stops deployment.
Both registry lookups use Artifact Registry tag metadata; Container Analysis access is not required.
This verifies source compatibility through the trusted build identity and artifact registry;
it is not an independent cryptographic image attestation.
Older upgrades require a separately verified writer-drain procedure. The workflow
does not delete retained revisions or bypass contraction safety to accommodate them.
When contraction is required, an unfiltered, two-name revision lookup must return
only the validated ready revision; empty, additional, or malformed rows stop the workflow.
Normal application retention continues unchanged; shared database and live smoke
checks can invoke that existing retention behavior, distinct from a deployment purge.

## Self-service tenant onboarding

After the strict revision is running at tenant contract version 2, new organizations register
directly through `POST /v1/tenants`. No operator credential or dashboard action is required. The
request atomically creates the tenant and its first tenant-administrator token; the raw secret is
derived from a caller-generated 256-bit registration secret and only its hash is stored. Exact
request retries return the same tenant and token, so a lost response does not require operator
recovery. Agents then set `MURMUR_API_TOKEN` and run `murmur setup --user` against the hosted MCP URL.

ChatGPT and Grok users do not run the local setup command. Create a dedicated narrowly bound
`agent` token, place it only in the connector Client Secret field, use client ID `murmur`, scope
`murmur`, the hosted `/oauth/authorize` and `/oauth/token` URLs, and select
`client_secret_basic` or `client_secret_post`. Operator and bootstrap credentials are rejected.
See [connector authentication](connector-authentication.md) for the complete form and trust model.

Keep the endpoint behind the same TLS, origin, request-capacity, and observability boundary as
`/mcp`. Configure `MURMUR_REGISTRATION_RATE_LIMIT_PER_MINUTE` only to tighten or scale the default
per-process limit; the database independently enforces cross-replica creation and retention caps.
The current no-paywall flow does not prove ownership of an organization name. Public operators
should add source-aware throttling at their trusted edge; application and database caps remain the
fail-safe bounds, not a substitute for edge abuse controls. Billing or ownership verification can
be added later without changing the tenant credential boundary.
Do not grant `anon` or `authenticated` direct execution on the private registration function or
direct access to its state table. See [self-service tenant onboarding](self-service-onboarding.md)
for the complete agent flow, response contract, failure handling, and credential setup.

## Tenant contract upgrade

The tenant-key upgrade is an expand-and-contract migration:

1. The expansion migration backfills tenant-local message sequences while
   retaining old global constraints and records contract version 1.
2. A compatible application revision is deployed and health-checked.
3. Traffic moves entirely to that revision and direct revision tags are removed.
   Retained revision definitions are not deleted. If any superseded revision
   remains, automatic finalization stops: independently verify writer drainage
   before performing the documented contraction. Routing is not drainage evidence.
4. `murmur.finalize_tenant_contract()` installs tenant-qualified primary and
   idempotency contracts atomically and records version 2.
5. Foreign keys are validated and the strict revision restarts with
   `MURMUR_TENANT_CONTRACT_VERSION=2`.

Finalization rolls back as one database transaction if it cannot complete. It
must never run while an older writer can receive traffic. After version 2, only
the tenant-qualified revision or a later compatible revision may be deployed.

## Agent lifecycle rollout

The lifecycle expansion assigns existing agents and messages to generation 1, creates a 60-minute
compatibility lease for every agent seen within the preceding hour, and installs generation snapshot
triggers before the new application handles traffic. Constraints are added before being validated in
separate transactions. Message-history and lifecycle cleanup indexes are built concurrently, and
schema lock waits fail after five seconds instead of blocking production work.

Concurrent index creation can leave a same-named `INVALID` index after an interrupted rollout. The
forward migrations inspect `pg_index`, drop only an invalid same-named artifact, and retry the
concurrent build; a valid index is preserved. Rerun the unchanged migration. Do not manually drop a
valid production index or edit an applied migration.

Do not leave a pre-lifecycle revision serving traffic after the compatibility leases can expire.
Older writers do not renew named leases and use the former broadcast audience rule. The automated
workflow rejects retained sources older than the supported compatibility floor before migrations;
an earlier upgrade requires independently verified writer drainage within this migration's
compatibility window. If rollout cannot complete inside that window, stop and deploy the current
forward revision; do not expose lifecycle tools alongside mixed broadcast semantics. Rollback to a
pre-lifecycle application is unsupported after any identity advances beyond generation 1.

## Orchestrator administration

Human-delegated orchestration is enabled only with `MURMUR_AUTH_MODE=multi-tenant`. A tenant
administrator creates an orchestrator token, records its one-time secret in the approved secret
store, and assigns any organization/personal policy with optional machine and repository qualifiers.
Create agent tokens with the matching `machine`/`repository` bindings; metadata and headers cannot
select a policy. The eight-form precedence is documented in [orchestration.md](orchestration.md).
Never place private instructions in audit metadata, messages, deployment variables, or repo files.

The workflow revokes policy `INSERT`/`UPDATE` from `murmur_app` before migrations and restores them
only after every replica and final health check pass. Existing policy reads remain available while
old replicas drain. A failed rollout stays frozen and must be fixed forward; follow the executable
and verified procedure in [upgrading.md](upgrading.md). Create machine-bound data only afterward.

Use `list_orchestrator_policies` to review scope, assignment, and updater attribution, following
`next_cursor` until it is null so all bounded policy pages are reviewed. Rotation is:

1. Record its policy scopes, then revoke the old orchestrator access token.
2. Create its replacement with the same reserved ID and intended machine/repository bindings.
3. Reapply each intended policy to the new token key.
4. Verify worker `get_orchestrator`, orchestrator `get_delegation`, and a durable routed ask.

Revocation stops new resolution immediately and closes local live sessions best-effort. Historical
messages retain their authenticated authority and policy ID. Switching the application to hybrid,
legacy, or local mode disables every orchestration tool, including for retained orchestrator
credentials; this is a capability rollback, not a database rollback. See
[orchestration.md](orchestration.md) for precedence and trust boundaries.

## Tenant E2E cutover

Apply every hosted E2E migration and deploy the matching application on all replicas before a
tenant administrator begins provisioning. Then follow
[hosted-e2ee-operations.md](hosted-e2ee-operations.md). The cutover is tenant-scoped and audited;
operators cannot perform it or read tenant encryption data. Do not enforce from a database console,
skip endpoint fingerprint verification, or leave an older replica serving a stale plaintext tool
matrix. Every effective transition closes the tenant's sessions so clients reconnect against the
new server-derived capability.

Treat enforcement as forward-only until ciphertext, claims, and pending broadcasts have expired and
bounded pruning reports zero. An application rollback target must understand the E2E schema and
continue honoring the durable entitlement and database plaintext-write trigger. Never drop E2E
tables, disable forced RLS, or reset entitlement rows to restore plaintext behavior.

## Manual strict deployment

Use this fallback only after operator bootstrap, legacy adoption, and tenant
contract finalization have completed. A first deployment must use the supervised
workflow because strict mode refuses to start without an operator.

```bash
export GOOGLE_CLOUD_PROJECT='your-project-id'
export MURMUR_RUNTIME_SERVICE_ACCOUNT='murmur-cloud-run@your-project-id.iam.gserviceaccount.com'
export MURMUR_RELEASE_REVISION="$(git rev-parse HEAD)"
export MURMUR_PUBLIC_ORIGIN='https://api.example.com'

gcloud run deploy murmur-mcp \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --region us-central1 \
  --source . \
  --service-account "$MURMUR_RUNTIME_SERVICE_ACCOUNT" \
  --update-env-vars MURMUR_AUTH_MODE=multi-tenant,MURMUR_ALLOW_BOOTSTRAP=0,MURMUR_DATABASE_CA_PATH=/etc/murmur/secrets/database-ca.pem,MURMUR_DATABASE_TLS_INSECURE=0,MURMUR_MAX_STREAM_LIFETIME_MS=3300000,MURMUR_PUBLIC_ORIGIN="$MURMUR_PUBLIC_ORIGIN",MURMUR_RELEASE_REVISION="$MURMUR_RELEASE_REVISION" \
  --set-secrets MURMUR_DATABASE_URL=MURMUR_DATABASE_URL:latest,/etc/murmur/secrets/database-ca.pem=MURMUR_DATABASE_CA:latest \
  --allow-unauthenticated \
  --concurrency 80 \
  --cpu 1 \
  --max 1 \
  --max-instances 1 \
  --memory 512Mi \
  --port 8080 \
  --no-use-http2 \
  --timeout 3600
```

Keep the Cloud Run request timeout above `MURMUR_MAX_STREAM_LIFETIME_MS`. Murmur hard-caps that
setting at 55 minutes and applies up to 10% deterministic per-session jitter, so streams rotate
before the 3,600-second platform backstop instead of relying on platform truncation. The stream
rotation preserves the MCP session and supported clients reconnect automatically.

Apply migrations before the matching server revision. For a manually managed
PostgreSQL deployment:

```bash
export MURMUR_DATABASE_URL='postgresql://...'
export MURMUR_DATABASE_CA_PATH='/absolute/path/to/server-root.crt'
VERIFIED_DATABASE_URL="$(MURMUR_DATABASE_URL_TO_VERIFY="$MURMUR_DATABASE_URL" \
  bun scripts/require-verified-database-url.ts)"
bunx supabase db push --db-url "$VERIFIED_DATABASE_URL" --include-all --yes
MURMUR_TEST_DATABASE_URL="$VERIFIED_DATABASE_URL" bun run test:cloud
```

Never use the Supabase transaction pooler: PostgreSQL `LISTEN/NOTIFY` requires
a stable session. `MURMUR_DATABASE_TLS_INSECURE=1` is a local-development escape
hatch for plaintext test databases and must not be set in production.

`MURMUR_PUBLIC_ORIGIN` is required for non-loopback connector OAuth routes. Set it to the canonical
external HTTPS origin. Murmur uses it directly and never trusts inbound host or proxy headers for
OAuth issuer or resource identity.

## Health and isolation canary

Confirm liveness without exposing credentials:

```bash
curl --fail --silent --show-error "$PRODUCTION_URL/health"
```

After every production change, run the operator-authenticated isolation canary:

```bash
gh workflow run production-smoke.yml --ref main
```

The accelerated HTTP regression suite proves rotation, timer cleanup, same-session reconnect, and
real SDK transport compatibility with an injected short lifetime. After rollout, retain a
real-window observation for at least 55 minutes: confirm `stream_rotated: true` completion events on
the new revision, successful reconnect traffic for the same hashed session correlation, continued
health/version success, and no new 3,600-second platform truncations or frontend HTML 500s.

Run that real-window verification separately after the ordinary isolation canary succeeds:

```bash
gh workflow run production-smoke.yml --ref main -f real_window=true
```

The opt-in mode shares the deployment concurrency group, checks the exact deployed source revision
and existing Cloud Logging read access before provisioning, and observes one disposable tenant's
SDK session. For a digest-only image, it resolves the expected source tag in the configured artifact
repository and requires that digest to match the deployed image before and after observation.
The bounded lookup reads only Artifact Registry tag metadata, without requiring Container Analysis.
It requires successful same-session stream reconnection, a new notification and durable
inbox delivery, then checks the corresponding server completion events and platform failures.
The platform-failure query stops at observation end. Later adversarial cleanup is independently
verified and may exercise a bounded 503 retry. Application-row lookup retains narrow timestamp slack
and bounded ingestion polling. The fixed 55-minute window and 70-minute job bound include setup,
targeted credential revocation, tenant suspension, and log-ingestion waits.
The observer binds its worker to its own tenant's existing personal identity, verifies revoked credentials
return 401, and suspends only its derived tenant; retained rows are not deleted. Session DELETEs retry
503 at most twice with one-second waits inside the 20-second deadline; only 200, 401, or 404 confirms
closure. Hosted PostgreSQL CI exercises setup and cleanup. Cloud authentication is refreshed before
reading final logs. Missing log-read or registry metadata permission fails closed; it never grants
IAM access automatically.

Log reads target the service-named view in the project's global `_Default` bucket, not the
project-wide log collection. Provision its filter and view-only IAM using
[production log access](production-log-access.md) before running the real-window mode.

The preflight and log verifier require explicit `PROJECT_ID`, `REGION`, `SERVICE`,
`ARTIFACT_REPOSITORY`, `PRODUCTION_URL`, `EXPECTED_GITHUB_SHA`, `MURMUR_LIVE_EXPECTED_VERSION`, and
`RUNNER_TEMP`. The observer uses `MURMUR_LIVE_URL`, `MURMUR_LIVE_OPERATOR_TOKEN`,
`MURMUR_LIVE_EXPECTED_SHA`, and `MURMUR_LIVE_EXPECTED_VERSION`, with explicit
`MURMUR_VERIFY_PRODUCTION_STREAM=1` opt-in. The workflow supplies them; credentials must not be
passed as command-line arguments. JSON evidence contains only allowlisted verification metadata
and a hashed session correlation. No other tenant's inbox is used by this opt-in observer.

The canary obtains and masks the operator credential through the deploy
identity. It creates a short-lived tenant credential, verifies operator/admin/
agent tool separation, intra-tenant direct and broadcast delivery,
cross-tenant denial, session binding, lifecycle state, historical inbox isolation,
repository notices, suspension and restoration, and audit history. A separate disposable E2E
tenant proves repository-bound key provisioning, state cutover, ciphertext-only tool exposure,
recipient decryption, atomic two-recipient encrypted broadcast fan-out, encrypted orchestrator
request/reply provenance, rollback refusal, and plaintext-fallback denial. Every live envelope is
checked by the isolated verifier before local decryption. The canary revokes the temporary
credential and leaves its uniquely named tenants suspended for inspection.

## Rollback and recovery

Application rollback is safe only when the target revision supports the current
`tenant_contract_version`. Contract version 2 is forward-only: do not redeploy a
version-1 writer. Superseded Cloud Run revision definitions and container images
remain available for diagnosis; direct revision tags are removed during traffic cutover.

The orchestrator migrations preserve existing rows, but an older application does not understand all authority or machine-scope fields. Prefer a fixed-forward rollout. Freeze every policy mutation
before migration because the final uniqueness contract is incompatible with the old writer's
four-column conflict target. During the machine expansion, old replicas use
`authenticate_principal_v2` while new replicas require v3; they may drain reads only, and no
machine-qualified data may be created until every replica is updated. After use, only this release or
a later schema-compatible binary is supported. Emergency capability rollback uses a compatible
binary in hybrid mode; never drop policy, binding, or provenance columns.

Runtime database credentials are versioned. Before rolling back to a compatible
revision that references an older version, explicitly re-enable that exact
`MURMUR_DATABASE_URL` secret version and confirm it is a `murmur_app` credential.
Never substitute the migration-owner URL.

For lost operator credentials, follow the
[owner-only operator recovery runbook](operator-recovery.md). Record the
incident, rotation, validation, and revocation evidence. Do not paste database
URLs or raw tokens into chat, shell arguments, logs, or issue text.

## Custom domain and clients

Map a custom domain, then install the DNS records returned by Google:

```bash
gcloud beta run domain-mappings create \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --region us-central1 \
  --service murmur-mcp \
  --domain api.usemurmur.dev

gcloud beta run domain-mappings describe \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --region us-central1 \
  --domain api.usemurmur.dev
```

Configure clients with a role-scoped token in an environment variable:

```bash
export MURMUR_API_TOKEN='...'
codex mcp add murmur \
  --url https://api.usemurmur.dev/mcp \
  --bearer-token-env-var MURMUR_API_TOKEN
```

Use separate agent tokens when clients need independent revocation or rate
limits. A token fixes the tenant and role; clients never supply a tenant ID to
data tools.
