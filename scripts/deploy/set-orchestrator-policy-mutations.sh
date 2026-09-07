#!/usr/bin/env bash

set -euo pipefail

action="${1:-}"
case "$action" in
  freeze|unfreeze) ;;
  *)
    echo 'Usage: set-orchestrator-policy-mutations.sh freeze|unfreeze' >&2
    exit 1
    ;;
esac

database_url="${MURMUR_POLICY_ADMIN_DATABASE_URL:-}"
if [ -z "$database_url" ]; then
  database_url="$(gcloud secrets versions access latest \
    --project "$PROJECT_ID" \
    --secret MURMUR_CI_DATABASE_URL)"
fi
if [ "${MURMUR_DATABASE_TLS_INSECURE:-0}" != '1' ]; then
  database_url="$(MURMUR_DATABASE_URL_TO_VERIFY="$database_url" \
    bun scripts/require-verified-database-url.ts)"
fi

connection_parts=()
while IFS= read -r -d '' connection_part; do
  connection_parts+=("$connection_part")
done < <(MURMUR_POLICY_DATABASE_URL_TO_SPLIT="$database_url" bun -e '
  const value = process.env.MURMUR_POLICY_DATABASE_URL_TO_SPLIT;
  if (value === undefined) process.exit(1);
  const url = new URL(value);
  const sslMode = url.searchParams.get("sslmode") ?? "prefer";
  const parts = [
    url.hostname,
    url.port === "" ? "5432" : url.port,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
    sslMode,
  ];
  process.stdout.write(`${parts.join("\0")}\0`);
')
if [ "${#connection_parts[@]}" -ne 6 ]; then
  echo 'Policy administration database configuration is invalid.' >&2
  exit 1
fi
export PGHOST="${connection_parts[0]}"
export PGPORT="${connection_parts[1]}"
export PGUSER="${connection_parts[2]}"
export PGPASSWORD="${connection_parts[3]}"
export PGDATABASE="${connection_parts[4]}"
export PGSSLMODE="${connection_parts[5]}"
export PGCONNECT_TIMEOUT=10
if [ -n "${MURMUR_DATABASE_CA_PATH:-}" ]; then
  export PGSSLROOTCERT="$MURMUR_DATABASE_CA_PATH"
fi

table_name="$(psql \
  --set ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --command "select pg_catalog.to_regclass('murmur.orchestrator_policies')")"
if [ -z "$table_name" ]; then
  if [ "$action" = 'freeze' ]; then
    echo 'Orchestrator policy storage is not installed; no mutations need freezing.'
    exit 0
  fi
  echo 'Orchestrator policy storage is missing after migration.' >&2
  exit 1
fi

if [ "$action" = 'freeze' ]; then
  privilege_statement='revoke insert, update on table murmur.orchestrator_policies from murmur_app'
  expected_privileges='t|f|f'
  result_label='frozen'
else
  privilege_statement='grant select, insert, update on table murmur.orchestrator_policies to murmur_app'
  expected_privileges='t|t|t'
  result_label='unfrozen'
fi

psql \
  --set ON_ERROR_STOP=1 \
  --command "begin; set local lock_timeout = '5s'; set local statement_timeout = '30s'; $privilege_statement; commit;"
privileges="$(psql \
  --set ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --command "select
    has_table_privilege('murmur_app', 'murmur.orchestrator_policies', 'select'),
    has_table_privilege('murmur_app', 'murmur.orchestrator_policies', 'insert'),
    has_table_privilege('murmur_app', 'murmur.orchestrator_policies', 'update')")"
if [ "$privileges" != "$expected_privileges" ]; then
  echo "Orchestrator policy mutation privileges did not reach the requested state: $privileges" >&2
  exit 1
fi

echo "Orchestrator policy mutations are $result_label."
unset connection_part connection_parts database_url expected_privileges privilege_statement
unset privileges result_label table_name
