#!/usr/bin/env bash

set -euo pipefail

admin_url="${MURMUR_MIGRATION_TEST_ADMIN_URL:-}"
if [ -z "$admin_url" ]; then
  echo 'MURMUR_MIGRATION_TEST_ADMIN_URL is required' >&2
  exit 1
fi

migration_database="murmur_connector_${RANDOM}_$$"
if ! [[ "$migration_database" =~ ^murmur_connector_[0-9]+_[0-9]+$ ]]; then
  echo 'Generated unsafe connector migration database name' >&2
  exit 1
fi
work_directory="$(mktemp -d /tmp/murmur-connector-migration.XXXXXX)"
cleanup() {
  dropdb --if-exists --force --maintenance-db "$admin_url" "$migration_database" \
    >/dev/null 2>&1 || true
  rm -rf "$work_directory"
}
trap cleanup EXIT

createdb --maintenance-db "$admin_url" "$migration_database"
migration_url="$(MURMUR_BASE_DATABASE_URL="$admin_url" \
  MURMUR_MIGRATION_DATABASE="$migration_database" \
  bun -e '
    const value = process.env.MURMUR_BASE_DATABASE_URL;
    const database = process.env.MURMUR_MIGRATION_DATABASE;
    if (value === undefined || database === undefined) process.exit(1);
    const url = new URL(value);
    url.pathname = `/${database}`;
    process.stdout.write(url.toString());
  ')"

mkdir -p "$work_directory/supabase/migrations"
for migration in supabase/migrations/*.sql; do
  migration_name="${migration##*/}"
  if [[ "$migration_name" != 20260902175*.sql && "$migration_name" != 2026090604000*.sql ]]; then
    cp "$migration" "$work_directory/supabase/migrations/$migration_name"
  fi
done
bunx supabase db push --workdir "$work_directory" \
  --db-url "$migration_url" --include-all --yes

psql "$migration_url" --set ON_ERROR_STOP=1 <<'SQL'
begin;
set local murmur.tenant_id = '00000000-0000-4000-8000-000000000001';

insert into murmur.agents(
  tenant_id, agent_id, display_name, metadata, created_at, last_seen_at
) values
  (
    '00000000-0000-4000-8000-000000000001', 'connector-migration-sender',
    'Connector migration sender', '{}', statement_timestamp(), statement_timestamp()
  ),
  (
    '00000000-0000-4000-8000-000000000001', 'connector-migration-recipient',
    'Connector migration recipient', '{}', statement_timestamp(), statement_timestamp()
  );

insert into murmur.messages(
  tenant_id, message_id, thread_id, sender_id, recipient_id, content,
  repository_name, branch_name, client_name, created_at, expires_at
) values (
  '00000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001', 'connector-migration-message',
  'connector-migration-sender', 'connector-migration-recipient', 'preserved message',
  'owner/repository', 'migration', 'codex', statement_timestamp(),
  statement_timestamp() + interval '30 days'
);

insert into murmur.broadcasts(
  tenant_id, broadcast_id, thread_id, sender_id, content,
  repository_name, branch_name, client_name, created_at, expires_at
) values (
  '00000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000002', 'connector-migration-broadcast',
  'connector-migration-sender', 'preserved broadcast', 'owner/repository',
  'migration', 'codex', statement_timestamp(), statement_timestamp() + interval '30 days'
);

insert into murmur.feedback_submissions(
  tenant_id, feedback_id, submission_type, reporter_id, reporter_generation,
  repository_name, branch_name, client_name, title, description, created_at
) values (
  '00000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000003', 'issue',
  'connector-migration-sender', 1, 'owner/repository', 'migration', 'codex',
  'Preserved feedback', 'Preserved feedback body', statement_timestamp()
);

commit;
SQL

expansion='20260902175459_allow_connector_client.sql'
cp "supabase/migrations/$expansion" "$work_directory/supabase/migrations/$expansion"
bunx supabase db push --workdir "$work_directory" \
  --db-url "$migration_url" --include-all --yes

unvalidated="$(psql "$migration_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select count(*) from pg_catalog.pg_constraint where conname like '%_connector' and not convalidated")"
if [ "$unvalidated" != '3' ]; then
  echo "Connector constraint expansion was not independently staged: $unvalidated" >&2
  exit 1
fi

validation='20260902175500_validate_message_connector_client.sql'
cp "supabase/migrations/$validation" "$work_directory/supabase/migrations/$validation"
lock_ready="$work_directory/message-lock-ready"
lock_output="$work_directory/message-lock-output"
lock_control="$work_directory/message-lock-control"
mkfifo "$lock_control"
psql "$migration_url" --set ON_ERROR_STOP=1 <"$lock_control" >"$lock_output" 2>&1 &
locker_pid=$!
exec 3>"$lock_control"
printf '%s\n' \
  'begin;' \
  'lock table murmur.messages in access exclusive mode;' \
  "\\o $lock_ready" \
  "select 'ready';" \
  '\o' >&3
timeout 3s bash -c 'while [ ! -s "$1" ]; do :; done' connector-lock "$lock_ready"
failed_push="$work_directory/failed-push"
if bunx supabase db push --workdir "$work_directory" \
  --db-url "$migration_url" --include-all --yes >"$failed_push" 2>&1; then
  echo 'Connector validation unexpectedly ignored its conflicting table lock' >&2
  exit 1
fi
if ! grep -q 'lock timeout' "$failed_push"; then
  echo 'Connector validation did not report its bounded lock timeout' >&2
  exit 1
fi
printf '%s\n' 'commit;' '\q' >&3
exec 3>&-
wait "$locker_pid"
bunx supabase db push --workdir "$work_directory" \
  --db-url "$migration_url" --include-all --yes

for migration in \
  '20260902175501_validate_broadcast_connector_client.sql' \
  '20260902175502_validate_feedback_connector_client.sql' \
  '20260902175503_finalize_connector_client_constraints.sql'; do
  cp "supabase/migrations/$migration" "$work_directory/supabase/migrations/$migration"
  bunx supabase db push --workdir "$work_directory" \
    --db-url "$migration_url" --include-all --yes
done

constraint_state="$(psql "$migration_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select count(*) filter (where conname in ('messages_client_name_allowed', 'broadcasts_client_name_allowed', 'feedback_submissions_client_known') and convalidated) || '|' || count(*) filter (where conname like '%_connector') from pg_catalog.pg_constraint")"
if [ "$constraint_state" != '3|0' ]; then
  echo "Connector constraints were not finalized safely: $constraint_state" >&2
  exit 1
fi

psql "$migration_url" --set ON_ERROR_STOP=1 <<'SQL'
begin;
set local murmur.tenant_id = '00000000-0000-4000-8000-000000000001';
update murmur.messages set client_name = 'connector'
where thread_id = 'connector-migration-message';
update murmur.broadcasts set client_name = 'connector'
where thread_id = 'connector-migration-broadcast';
update murmur.feedback_submissions set client_name = 'connector'
where feedback_id = '52000000-0000-4000-8000-000000000003';
commit;
SQL

slug_expansion='20260906040000_allow_client_slugs.sql'
cp "supabase/migrations/$slug_expansion" "$work_directory/supabase/migrations/$slug_expansion"
bunx supabase db push --workdir "$work_directory" \
  --db-url "$migration_url" --include-all --yes

unvalidated_slug="$(psql "$migration_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select count(*) from pg_catalog.pg_constraint where conname like '%_slug' and not convalidated")"
if [ "$unvalidated_slug" != '3' ]; then
  echo "Client slug constraint expansion was not independently staged: $unvalidated_slug" >&2
  exit 1
fi

slug_validation='20260906040001_validate_message_client_slug.sql'
cp "supabase/migrations/$slug_validation" "$work_directory/supabase/migrations/$slug_validation"
slug_lock_ready="$work_directory/slug-message-lock-ready"
slug_lock_output="$work_directory/slug-message-lock-output"
slug_lock_control="$work_directory/slug-message-lock-control"
mkfifo "$slug_lock_control"
psql "$migration_url" --set ON_ERROR_STOP=1 <"$slug_lock_control" >"$slug_lock_output" 2>&1 &
slug_locker_pid=$!
exec 4>"$slug_lock_control"
printf '%s\n' \
  'begin;' \
  'lock table murmur.messages in access exclusive mode;' \
  "\\o $slug_lock_ready" \
  "select 'ready';" \
  '\o' >&4
timeout 3s bash -c 'while [ ! -s "$1" ]; do :; done' slug-lock "$slug_lock_ready"
failed_slug_push="$work_directory/failed-slug-push"
if bunx supabase db push --workdir "$work_directory" \
  --db-url "$migration_url" --include-all --yes >"$failed_slug_push" 2>&1; then
  echo 'Client slug validation unexpectedly ignored its conflicting table lock' >&2
  exit 1
fi
if ! grep -q 'lock timeout' "$failed_slug_push"; then
  echo 'Client slug validation did not report its bounded lock timeout' >&2
  exit 1
fi
printf '%s\n' 'commit;' '\q' >&4
exec 4>&-
wait "$slug_locker_pid"
bunx supabase db push --workdir "$work_directory" \
  --db-url "$migration_url" --include-all --yes

for migration in \
  '20260906040002_validate_broadcast_client_slug.sql' \
  '20260906040003_validate_feedback_client_slug.sql' \
  '20260906040004_finalize_client_slug_constraints.sql'; do
  cp "supabase/migrations/$migration" "$work_directory/supabase/migrations/$migration"
  bunx supabase db push --workdir "$work_directory" \
    --db-url "$migration_url" --include-all --yes
done

slug_constraint_state="$(psql "$migration_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select count(*) filter (where conname in ('messages_client_name_allowed', 'broadcasts_client_name_allowed', 'feedback_submissions_client_known') and convalidated) || '|' || count(*) filter (where conname like '%_slug') from pg_catalog.pg_constraint")"
if [ "$slug_constraint_state" != '3|0' ]; then
  echo "Client slug constraints were not finalized safely: $slug_constraint_state" >&2
  exit 1
fi

psql "$migration_url" --set ON_ERROR_STOP=1 <<'SQL'
begin;
set local murmur.tenant_id = '00000000-0000-4000-8000-000000000001';
update murmur.messages set client_name = 'cursor-agent'
where thread_id = 'connector-migration-message';
update murmur.broadcasts set client_name = 'cursor-agent'
where thread_id = 'connector-migration-broadcast';
update murmur.feedback_submissions set client_name = 'cursor-agent'
where feedback_id = '52000000-0000-4000-8000-000000000003';
commit;
SQL

if psql "$migration_url" --set ON_ERROR_STOP=1 \
  --command "begin; set local murmur.tenant_id = '00000000-0000-4000-8000-000000000001'; update murmur.messages set client_name = 'Cursor' where thread_id = 'connector-migration-message'; rollback;" \
  >/dev/null 2>&1; then
  echo 'Message client constraint accepted an uppercase slug' >&2
  exit 1
fi
if psql "$migration_url" --set ON_ERROR_STOP=1 \
  --command "begin; set local murmur.tenant_id = '00000000-0000-4000-8000-000000000001'; update murmur.broadcasts set client_name = 'cursor/agent' where thread_id = 'connector-migration-broadcast'; rollback;" \
  >/dev/null 2>&1; then
  echo 'Broadcast client constraint accepted punctuation outside the slug alphabet' >&2
  exit 1
fi
if psql "$migration_url" --set ON_ERROR_STOP=1 \
  --command "begin; set local murmur.tenant_id = '00000000-0000-4000-8000-000000000001'; update murmur.feedback_submissions set client_name = repeat('a', 33) where feedback_id = '52000000-0000-4000-8000-000000000003'; rollback;" \
  >/dev/null 2>&1; then
  echo 'Feedback client constraint accepted an overlong slug' >&2
  exit 1
fi

echo 'Populated connector and client slug migration lock-timeout fixtures passed'
