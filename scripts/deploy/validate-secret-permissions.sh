#!/usr/bin/env bash

set -euo pipefail

database_url="$(gcloud secrets versions access latest \
  --project "$PROJECT_ID" \
  --secret MURMUR_CI_DATABASE_URL)"
echo "::add-mask::$database_url"
database_url="$(MURMUR_DATABASE_URL_TO_VERIFY="$database_url" \
  bun scripts/require-verified-database-url.ts)"
echo "::add-mask::$database_url"
runtime_database_version="$(gcloud secrets versions list MURMUR_DATABASE_URL \
  --project "$PROJECT_ID" \
  --filter 'state=ENABLED' \
  --sort-by '~createTime' \
  --limit 1 \
  --format 'value(name)')"
if [ -z "$runtime_database_version" ]; then
  echo 'MURMUR_DATABASE_URL has no enabled version' >&2
  exit 1
fi
runtime_database_value="$(gcloud secrets versions access "${runtime_database_version##*/}" \
  --project "$PROJECT_ID" \
  --secret MURMUR_DATABASE_URL)"
echo "::add-mask::$runtime_database_value"
legacy_secret_value_required=1
operator_secret_value_required=0
platform_state_exists="$(psql "$database_url" --set ON_ERROR_STOP=1 --tuples-only --no-align \
  --command "select to_regclass('murmur.platform_state') is not null")"
if [ "$platform_state_exists" = 't' ]; then
  legacy_adopted="$(psql "$database_url" --set ON_ERROR_STOP=1 --tuples-only --no-align \
    --command 'select legacy_imported_at is not null from murmur.platform_state where singleton_id = 1')"
  if [ "$legacy_adopted" = 't' ]; then
    legacy_secret_value_required=0
  fi
  operator_probe_exists="$(psql "$database_url" --set ON_ERROR_STOP=1 --tuples-only --no-align \
    --command "select to_regprocedure('murmur.operator_has_active_token()') is not null")"
  if [ "$operator_probe_exists" = 't' ]; then
    has_operator="$(psql "$database_url" --set ON_ERROR_STOP=1 --tuples-only --no-align \
      --command 'select murmur.operator_has_active_token()')"
    if [ "$has_operator" = 't' ] && [ "$legacy_secret_value_required" = '1' ]; then
      operator_secret_value_required=1
    fi
  fi
fi
legacy_secret_exists="$(MURMUR_LEGACY_SECRET_VALUE_REQUIRED="$legacy_secret_value_required" \
  bun scripts/verify-deploy-secret-permissions.ts)"
case "$legacy_secret_exists" in
  true|false) ;;
  *)
    echo 'Secret Manager preflight returned an invalid legacy-secret state' >&2
    exit 1
    ;;
esac
if [ "$legacy_secret_exists" = 'true' ]; then
  gcloud secrets get-iam-policy MURMUR_API_TOKEN \
    --project "$PROJECT_ID" \
    --format none >/dev/null
fi
if [ "$legacy_secret_value_required" = '1' ]; then
  legacy_secret_value="$(gcloud secrets versions access latest \
    --project "$PROJECT_ID" \
    --secret MURMUR_API_TOKEN)"
  echo "::add-mask::$legacy_secret_value"
fi
if [ "$operator_secret_value_required" = '1' ]; then
  operator_secret_value="$(gcloud secrets versions access latest \
    --project "$PROJECT_ID" \
    --secret MURMUR_OPERATOR_TOKEN)"
  echo "::add-mask::$operator_secret_value"
fi
echo "MURMUR_LEGACY_SECRET_EXISTS=$legacy_secret_exists" >> "$GITHUB_ENV"
unset database_url has_operator legacy_adopted legacy_secret_exists legacy_secret_value legacy_secret_value_required operator_probe_exists operator_secret_value operator_secret_value_required platform_state_exists runtime_database_value runtime_database_version
