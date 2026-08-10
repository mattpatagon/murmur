# Hosted deployment

This runbook covers the supported production deployment: GitHub Actions to
Google Cloud Run, with Supabase PostgreSQL and Google Secret Manager. The
committed workflow is the source of truth for sequencing:
`.github/workflows/deploy.yml` runs on every push to `main` and can also be
started manually.

## Service contract

The deployed service exposes:

- `GET /health`, an unauthenticated liveness endpoint that returns a JSON
  `status` of `ok` only after startup has completed.
- `/mcp`, a public Streamable HTTP endpoint that requires a live Murmur bearer
  token for every MCP request.

Cloud Run ingress is public so generic MCP clients can connect. Public ingress
does not bypass Murmur authorization. The initial deployment uses one instance
because MCP sessions are in memory; messages and authorization state remain
durable in PostgreSQL across restarts.

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
- Bun 1.3.11 for manual verification and recovery work.

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
2. Authenticate with workload identity, validate secret permissions, install
   the CA, apply all pending migrations, and run the shared PostgreSQL suite.
3. Build an image tagged with the Git commit SHA and push it to Artifact
   Registry.
4. Inspect enabled runtime-secret versions. Reuse a valid `murmur_app`
   credential, recover an interrupted credential rotation, or create and apply
   a new random runtime password.
5. Deploy a compatibility revision when legacy adoption is still required,
   atomically bootstrap the first operator if necessary, adopt the founding
   token, and switch to strict multi-tenant authorization.
6. Route all traffic to the healthy revision and drain superseded revisions
   before any forward-only database contraction.
7. Finalize and validate tenant-qualified foreign keys when the database is at
   contract version 1, restart the strict revision at contract version 2, and
   verify health again.
8. Disable superseded runtime database-secret versions only after the final
   revision and tenant contract are healthy.

Every phase fails closed. Credential and adoption state are read from the
database and Secret Manager on each run, so an interrupted workflow resumes
from durable state instead of assuming the previous attempt finished.

## Tenant contract upgrade

The tenant-key upgrade is an expand-and-contract migration:

1. The expansion migration backfills tenant-local message sequences while
   retaining old global constraints and records contract version 1.
2. A compatible application revision is deployed and health-checked.
3. Traffic moves entirely to that revision and older Cloud Run revisions are
   deleted, terminating old streams and preventing an incompatible writer from
   returning.
4. `murmur.finalize_tenant_contract()` installs tenant-qualified primary and
   idempotency contracts atomically and records version 2.
5. Foreign keys are validated and the strict revision restarts with
   `MURMUR_TENANT_CONTRACT_VERSION=2`.

Finalization rolls back as one database transaction if it cannot complete. It
must never run while an older writer can receive traffic. After version 2, only
the tenant-qualified revision or a later compatible revision may be deployed.

## Manual strict deployment

Use this fallback only after operator bootstrap, legacy adoption, and tenant
contract finalization have completed. A first deployment must use the supervised
workflow because strict mode refuses to start without an operator.

```bash
export GOOGLE_CLOUD_PROJECT='your-project-id'
export MURMUR_RUNTIME_SERVICE_ACCOUNT='murmur-cloud-run@your-project-id.iam.gserviceaccount.com'

gcloud run deploy murmur-mcp \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --region us-central1 \
  --source . \
  --service-account "$MURMUR_RUNTIME_SERVICE_ACCOUNT" \
  --update-env-vars MURMUR_AUTH_MODE=multi-tenant,MURMUR_ALLOW_BOOTSTRAP=0,MURMUR_DATABASE_CA_PATH=/etc/murmur/secrets/database-ca.pem,MURMUR_DATABASE_TLS_INSECURE=0 \
  --set-secrets MURMUR_DATABASE_URL=MURMUR_DATABASE_URL:latest,/etc/murmur/secrets/database-ca.pem=MURMUR_DATABASE_CA:latest \
  --allow-unauthenticated \
  --concurrency 80 \
  --max-instances 1 \
  --memory 512Mi \
  --port 8080 \
  --timeout 3600
```

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

## Health and isolation canary

Confirm liveness without exposing credentials:

```bash
curl --fail --silent --show-error "$PRODUCTION_URL/health"
```

After every production change, run the operator-authenticated isolation canary:

```bash
gh workflow run production-smoke.yml --ref main
```

The canary obtains and masks the operator credential through the deploy
identity. It creates a short-lived tenant credential, verifies operator/admin/
agent tool separation, intra-tenant direct and broadcast delivery,
cross-tenant denial, session binding, suspension and restoration, and audit
history. It revokes the temporary credential and leaves its uniquely named
tenant suspended for inspection.

## Rollback and recovery

Application rollback is safe only when the target revision supports the current
`tenant_contract_version`. Contract version 2 is forward-only: do not redeploy a
version-1 writer. Container images remain available for diagnosis after old
Cloud Run revisions are drained.

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
