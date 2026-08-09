#!/usr/bin/env bash

set -euo pipefail

database_url="${MURMUR_MIGRATION_DATABASE_URL:-}"
if [ -z "$database_url" ]; then
  echo 'MURMUR_MIGRATION_DATABASE_URL is required' >&2
  exit 1
fi

prune_table() {
  local table_name="$1"
  local deleted_rows='0'
  local total_deleted='0'
  local table_exists=''
  table_exists="$(psql "$database_url" \
    --set ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --quiet \
    --command "select pg_catalog.to_regclass('murmur.$table_name') is not null")"
  if [ "$table_exists" != 't' ]; then
    echo "Skipped expired $table_name pruning because the table does not exist yet"
    return
  fi
  while true; do
    deleted_rows="$(psql "$database_url" \
      --set ON_ERROR_STOP=1 \
      --tuples-only \
      --no-align \
      --quiet \
      --command "set lock_timeout = '5s';
        set statement_timeout = '2min';
        with expired as (
          select ctid
          from murmur.$table_name
          where expires_at <= statement_timestamp()
          order by expires_at
          limit 5000
        ), deleted as (
          delete from murmur.$table_name as retained
          using expired
          where retained.ctid = expired.ctid
          returning 1
        )
        select count(*) from deleted;")"
    total_deleted="$((total_deleted + deleted_rows))"
    if [ "$deleted_rows" -eq 0 ]; then
      break
    fi
  done
  echo "Pruned $total_deleted expired $table_name rows before tenant quota validation"
  unset table_exists
}

prune_table messages
prune_table broadcasts
