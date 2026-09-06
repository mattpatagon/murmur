#!/usr/bin/env bash

set -euo pipefail

database_url="$(gcloud secrets versions access latest \
  --project "$PROJECT_ID" \
  --secret MURMUR_CI_DATABASE_URL)"
echo "::add-mask::$database_url"
bootstrap_database_credential="$database_url"
database_url="$(MURMUR_DATABASE_URL_TO_VERIFY="$database_url" \
  bun scripts/require-verified-database-url.ts)"
echo "::add-mask::$database_url"
bunx supabase db push --db-url "$database_url" --include-all --yes
MURMUR_BOOTSTRAP_DATABASE_CREDENTIAL="$bootstrap_database_credential" \
  MURMUR_BOOTSTRAP_DATABASE_URL="$database_url" \
  bun run scripts/configure-operator-bootstrap.ts
has_operator="$(psql "$database_url" --tuples-only --no-align \
  --command 'select murmur.operator_has_active_token()')"
legacy_adopted="$(psql "$database_url" --tuples-only --no-align \
  --command 'select legacy_imported_at is not null from murmur.platform_state where singleton_id = 1')"
tenant_contract_version="$(psql "$database_url" --tuples-only --no-align \
  --command 'select tenant_contract_version from murmur.platform_state where singleton_id = 1')"
if [ "$legacy_adopted" != 't' ]; then
  legacy_token="$(gcloud secrets versions access latest \
    --project "$PROJECT_ID" \
    --secret MURMUR_API_TOKEN)"
  echo "::add-mask::$legacy_token"
  MURMUR_LEGACY_TOKEN_TO_VALIDATE="$legacy_token" bun -e '
    import { DatabaseCredentialPattern } from "./src/hosted/token-secret.ts";
    const token = process.env.MURMUR_LEGACY_TOKEN_TO_VALIDATE;
    if (token === undefined || !DatabaseCredentialPattern.test(token)) {
      throw new Error("MURMUR_API_TOKEN cannot be adopted by strict authentication");
    }
  '
  unset legacy_token
fi
current_runtime_version=''
fallback_runtime_version=''
runtime_role_ready=false
while IFS= read -r candidate_version; do
  if candidate_url="$(gcloud secrets versions access "${candidate_version##*/}" \
    --project "$PROJECT_ID" \
    --secret MURMUR_DATABASE_URL)"; then
    echo "::add-mask::$candidate_url"
    candidate_url="$(MURMUR_DATABASE_URL_TO_VERIFY="$candidate_url" \
      bun scripts/require-verified-database-url.ts)"
    echo "::add-mask::$candidate_url"
    candidate_kind="$(MURMUR_RUNTIME_DATABASE_URL_TO_INSPECT="$candidate_url" \
      bun scripts/provision-runtime-database.ts)"
    if [ "$candidate_kind" = 'runtime' ]; then
      current_runtime_version="${candidate_version##*/}"
      runtime_role_ready=true
      unset candidate_url candidate_kind
      break
    fi
    if [ "$candidate_kind" != 'template' ]; then
      echo "MURMUR_DATABASE_URL version ${candidate_version##*/} has an invalid credential kind" >&2
      exit 1
    fi
    if [ -z "$fallback_runtime_version" ]; then
      fallback_runtime_version="${candidate_version##*/}"
    fi
    unset candidate_url candidate_kind
  fi
done < <(gcloud secrets versions list MURMUR_DATABASE_URL \
  --project "$PROJECT_ID" \
  --filter 'state=ENABLED' \
  --sort-by '~createTime' \
  --format 'value(name)')
if [ -z "$current_runtime_version" ]; then
  current_runtime_version="$fallback_runtime_version"
fi
if [ -z "$current_runtime_version" ]; then
  echo 'MURMUR_DATABASE_URL has no enabled version' >&2
  exit 1
fi
echo "RUNTIME_DATABASE_SECRET_VERSION=$current_runtime_version" >> "$GITHUB_ENV"
if [ "$has_operator" = 't' ]; then
  echo 'BOOTSTRAP_REQUIRED=false' >> "$GITHUB_ENV"
else
  echo 'BOOTSTRAP_REQUIRED=true' >> "$GITHUB_ENV"
fi
if [ "$legacy_adopted" = 't' ]; then
  echo 'ADOPTION_REQUIRED=false' >> "$GITHUB_ENV"
else
  echo 'ADOPTION_REQUIRED=true' >> "$GITHUB_ENV"
fi
if [ "$runtime_role_ready" = 'true' ]; then
  echo 'RUNTIME_PROVISION_REQUIRED=false' >> "$GITHUB_ENV"
  echo 'RUNTIME_DATABASE_RECOVERY_REQUIRED=true' >> "$GITHUB_ENV"
else
  echo 'RUNTIME_PROVISION_REQUIRED=true' >> "$GITHUB_ENV"
  echo 'RUNTIME_DATABASE_RECOVERY_REQUIRED=false' >> "$GITHUB_ENV"
fi
case "$tenant_contract_version" in
  1)
    echo 'TENANT_CONTRACT_FINALIZE_REQUIRED=true' >> "$GITHUB_ENV"
    ;;
  2)
    echo 'TENANT_CONTRACT_FINALIZE_REQUIRED=false' >> "$GITHUB_ENV"
    ;;
  *)
    echo "Unsupported tenant contract version: $tenant_contract_version" >&2
    exit 1
    ;;
esac
if [ "$legacy_adopted" = 't' ] && [ "$has_operator" != 't' ]; then
  echo 'Legacy adoption cannot be complete without an active operator' >&2
  exit 1
fi
MURMUR_TEST_DATABASE_URL="$database_url" bun run test:cloud
unset bootstrap_database_credential
