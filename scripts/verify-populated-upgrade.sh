#!/usr/bin/env bash

set -euo pipefail

admin_url="${MURMUR_MIGRATION_TEST_ADMIN_URL:-}"
if [ -z "$admin_url" ]; then
  echo 'MURMUR_MIGRATION_TEST_ADMIN_URL is required' >&2
  exit 1
fi

upgrade_database="murmur_upgrade_${RANDOM}_$$"
if ! [[ "$upgrade_database" =~ ^murmur_upgrade_[0-9]+_[0-9]+$ ]]; then
  echo 'Generated unsafe migration fixture database name' >&2
  exit 1
fi
work_directory="$(mktemp -d /tmp/murmur-populated-upgrade.XXXXXX)"
cleanup() {
  dropdb --if-exists --force --maintenance-db "$admin_url" "$upgrade_database" >/dev/null 2>&1 || true
  rm -rf "$work_directory"
}
trap cleanup EXIT

createdb --maintenance-db "$admin_url" "$upgrade_database"
upgrade_url="$(MURMUR_BASE_DATABASE_URL="$admin_url" \
  MURMUR_UPGRADE_DATABASE="$upgrade_database" \
  bun -e '
    const value = process.env.MURMUR_BASE_DATABASE_URL;
    const database = process.env.MURMUR_UPGRADE_DATABASE;
    if (value === undefined || database === undefined) process.exit(1);
    const url = new URL(value);
    url.pathname = `/${database}`;
    process.stdout.write(url.toString());
  ')"

mkdir -p "$work_directory/supabase/migrations"
baseline_migrations=(
  '20260804141224_murmur_cloud_storage.sql'
  '20260804165947_add_message_repository_context.sql'
  '20260807160357_add_message_sender_context.sql'
  '20260807201545_broadcast_messages.sql'
  '20260807204308_broadcast_message_foreign_key.sql'
  '20260807204309_broadcast_message_recipient_index.sql'
  '20260807204311_broadcast_agent_activity_index.sql'
  '20260807204312_broadcast_agent_repository_index.sql'
  '20260807204315_broadcast_agent_machine_index.sql'
  '20260808224423_hosted_tenant_isolation.sql'
  '20260808224424_hosted_tenant_identity_indexes.sql'
  '20260808224425_hosted_tenant_constraints.sql'
  '20260808224426_hosted_tenant_constraint_validation.sql'
  '20260808224427_hosted_tenant_query_indexes.sql'
  '20260808224428_hosted_control_plane.sql'
)
for migration_name in "${baseline_migrations[@]}"; do
  migration="supabase/migrations/$migration_name"
  if [ ! -f "$migration" ]; then
    echo "Missing populated-upgrade baseline migration: $migration_name" >&2
    exit 1
  fi
  cp "$migration" "$work_directory/supabase/migrations/$migration_name"
done
bunx supabase db push --workdir "$work_directory" --db-url "$upgrade_url" --include-all --yes

psql "$upgrade_url" --set ON_ERROR_STOP=1 <<'SQL'
insert into murmur.agents(agent_id, display_name, metadata, created_at, last_seen_at)
values
  ('shared-agent', 'Founding shared agent', '{}', statement_timestamp(), statement_timestamp()),
  ('founding-recipient', 'Founding recipient', '{}', statement_timestamp(), statement_timestamp()),
  ('founding-only', 'Founding only', '{}', statement_timestamp(), statement_timestamp());

insert into murmur.access_tokens(
  token_id, tenant_id, key_id, secret_hash, token_role, name
) values (
  '41000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000001',
  'UpgradeA1',
  decode(repeat('42', 32), 'hex'),
  'agent',
  'Pre-orchestration upgrade credential'
);

insert into murmur.messages(
  message_id, thread_id, sender_id, recipient_id, content,
  repository_name, branch_name, client_name, idempotency_key,
  created_at, expires_at
)
values
  (
    '41000000-0000-4000-8000-000000000001', 'upgrade-thread-1',
    'shared-agent', 'founding-recipient', 'preserved message',
    'owner/repository', 'upgrade', 'codex', 'preserved-idempotency',
    statement_timestamp(), statement_timestamp() + interval '30 days'
  ),
  (
    '41000000-0000-4000-8000-000000000002', 'upgrade-thread-2',
    'shared-agent', 'founding-recipient', 'deleted cursor gap',
    'owner/repository', 'upgrade', 'codex', 'deleted-idempotency',
    statement_timestamp(), statement_timestamp() + interval '30 days'
  );

delete from murmur.messages
where message_id = '41000000-0000-4000-8000-000000000002';
SQL

for migration in supabase/migrations/*.sql; do
  migration_name="${migration##*/}"
  if [[ "$migration_name" > '20260809004137_tenant_key_contract.sql' ||
    "$migration_name" == '20260809004137_tenant_key_contract.sql' ]] &&
    [[ "$migration_name" < '20260810160000_agent_lifecycle_columns.sql' ]]; then
    cp "$migration" "$work_directory/supabase/migrations/$migration_name"
  fi
done
bunx supabase db push --workdir "$work_directory" --db-url "$upgrade_url" --include-all --yes

# Apply every lifecycle and orchestration phase as its own tracked migration. Each subsequent
# push replays the already-recorded prefix, modeling a process restart at every
# safe phase boundary. The explicit unchanged retry proves the quota cutover is
# recorded before later phases begin.
for migration in supabase/migrations/2026081016*.sql; do
  migration_name="${migration##*/}"
  cp "$migration" "$work_directory/supabase/migrations/$migration_name"
  bunx supabase db push --workdir "$work_directory" --db-url "$upgrade_url" --include-all --yes
  if [ "$migration_name" = '20260810160004_agent_quota_cutover.sql' ]; then
    bunx supabase db push --workdir "$work_directory" --db-url "$upgrade_url" --include-all --yes
  fi
done

lifecycle_backfill="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select (select count(*) from murmur.agent_sessions) || '|' || (select count(*) from murmur.agent_sessions where session_key = 'backfill' and generation = 1) || '|' || usage.agent_count || '|' || usage.retained_agent_count from murmur.tenant_resource_usage as usage where tenant_id = '00000000-0000-4000-8000-000000000001'")"
if [ "$lifecycle_backfill" != '3|3|3|3' ]; then
  echo "Lifecycle backfill or agent recount was unexpected: $lifecycle_backfill" >&2
  exit 1
fi

backfilled_identity="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select personal_id::text from murmur.access_tokens where token_id = '41000000-0000-4000-8000-000000000010'")"
if [ "$backfilled_identity" != '41000000-0000-4000-8000-000000000010' ]; then
  echo "Existing credential personal identity was not backfilled: $backfilled_identity" >&2
  exit 1
fi
v1_authentication="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select (select count(*) from jsonb_object_keys(to_jsonb(authenticated))) || '|' || authenticated.principal_kind || '|' || authenticated.token_id::text || '|' || authenticated.key_id || '|' || authenticated.tenant_id::text || '|' || authenticated.token_role from murmur.authenticate_principal(decode(repeat('42', 32), 'hex')) as authenticated")"
if [ "$v1_authentication" != '5|tenant|41000000-0000-4000-8000-000000000010|UpgradeA1|00000000-0000-4000-8000-000000000001|agent' ]; then
  echo "Authentication v1 row contract changed during expansion: $v1_authentication" >&2
  exit 1
fi
v2_authentication="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select (select count(*) from jsonb_object_keys(to_jsonb(authenticated))) || '|' || authenticated.principal_kind || '|' || authenticated.token_id::text || '|' || authenticated.personal_id::text || '|' || coalesce(authenticated.repository_name, '') || '|' || coalesce(authenticated.orchestrator_agent_id, '') from murmur.authenticate_principal_v2(decode(repeat('42', 32), 'hex')) as authenticated")"
if [ "$v2_authentication" != '8|tenant|41000000-0000-4000-8000-000000000010|41000000-0000-4000-8000-000000000010||' ]; then
  echo "Authentication v2 did not preserve the upgraded credential: $v2_authentication" >&2
  exit 1
fi

preserved_cursor="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select sequence || '|' || tenant_sequence || '|' || sender_generation || '|' || recipient_generation from murmur.messages where message_id = '41000000-0000-4000-8000-000000000001'")"
if [ "$preserved_cursor" != '1|1|1|1' ]; then
  echo "Existing cursor changed during backfill: $preserved_cursor" >&2
  exit 1
fi
counter_after_gap="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select last_sequence from murmur.tenant_message_sequences where tenant_id = '00000000-0000-4000-8000-000000000001'")"
if [ "$counter_after_gap" != '2' ]; then
  echo "Founding counter did not preserve the deleted global cursor: $counter_after_gap" >&2
  exit 1
fi

psql "$upgrade_url" --set ON_ERROR_STOP=1 <<'SQL'
begin;
insert into murmur.messages(
  message_id, thread_id, sender_id, recipient_id, content,
  repository_name, branch_name, client_name, created_at, expires_at
) values (
  '41000000-0000-4000-8000-000000000003', 'upgrade-rollback',
  'shared-agent', 'founding-recipient', 'rolled back sequence',
  'owner/repository', 'upgrade', 'codex',
  statement_timestamp(), statement_timestamp() + interval '30 days'
);
rollback;

insert into murmur.messages(
  message_id, thread_id, sender_id, recipient_id, content,
  repository_name, branch_name, client_name, idempotency_key,
  created_at, expires_at
) values (
  '41000000-0000-4000-8000-000000000004', 'upgrade-thread-4',
  'shared-agent', 'founding-recipient', 'post-gap message',
  'owner/repository', 'upgrade', 'codex', 'cross-tenant-idempotency',
  statement_timestamp(), statement_timestamp() + interval '30 days'
);
SQL

compatible_cursor="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select sequence || '|' || tenant_sequence || '|' || sender_generation || '|' || recipient_generation from murmur.messages where message_id = '41000000-0000-4000-8000-000000000004'")"
if [ "$compatible_cursor" != '4|4|1|1' ]; then
  echo "Contract-v1 cursor diverged after a rollback gap: $compatible_cursor" >&2
  exit 1
fi

finalized="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command 'select murmur.finalize_tenant_contract()')"
finalized_again="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command 'select murmur.finalize_tenant_contract()')"
if [ "$finalized" != 't' ] || [ "$finalized_again" != 'f' ]; then
  echo "Tenant contract finalizer was not idempotent: $finalized|$finalized_again" >&2
  exit 1
fi
psql "$upgrade_url" --set ON_ERROR_STOP=1 \
  --command 'select murmur.validate_tenant_contract()'

psql "$upgrade_url" --set ON_ERROR_STOP=1 <<'SQL'
insert into murmur.tenants(tenant_id, slug, display_name)
values ('42000000-0000-4000-8000-000000000001', 'upgrade-tenant', 'Upgrade tenant');

insert into murmur.agents(tenant_id, agent_id, display_name, metadata, created_at, last_seen_at)
values
  ('42000000-0000-4000-8000-000000000001', 'shared-agent', 'Tenant shared agent', '{}', statement_timestamp(), statement_timestamp()),
  ('42000000-0000-4000-8000-000000000001', 'tenant-recipient', 'Tenant recipient', '{}', statement_timestamp(), statement_timestamp());

insert into murmur.messages(
  tenant_id, message_id, thread_id, sender_id, recipient_id, content,
  repository_name, branch_name, client_name, idempotency_key,
  created_at, expires_at
) values (
  '42000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000002', 'tenant-thread',
  'shared-agent', 'tenant-recipient', 'tenant-local sequence',
  'owner/repository', 'upgrade', 'codex', 'cross-tenant-idempotency',
  statement_timestamp(), statement_timestamp() + interval '30 days'
);
SQL

tenant_cursor="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select tenant_sequence from murmur.messages where message_id = '42000000-0000-4000-8000-000000000002'")"
if [ "$tenant_cursor" != '1' ]; then
  echo "New tenant did not receive a local cursor: $tenant_cursor" >&2
  exit 1
fi

contract_state="$(psql "$upgrade_url" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select state.tenant_contract_version || '|' || (column_default is null)::text || '|' || usage.agent_count || '|' || usage.retained_agent_count || '|' || usage.message_count from murmur.platform_state as state cross join information_schema.columns as column_info join murmur.tenant_resource_usage as usage on usage.tenant_id = '42000000-0000-4000-8000-000000000001' where state.singleton_id = 1 and column_info.table_schema = 'murmur' and column_info.table_name = 'agents' and column_info.column_name = 'tenant_id'")"
if [ "$contract_state" != '2|true|2|2|1' ]; then
  echo "Final tenant contract state was unexpected: $contract_state" >&2
  exit 1
fi

if psql "$upgrade_url" --set ON_ERROR_STOP=1 --command "
  insert into murmur.messages(
    tenant_id, message_id, thread_id, sender_id, recipient_id, content,
    repository_name, branch_name, client_name, created_at, expires_at
  ) values (
    '42000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000003', 'cross-tenant-fk',
    'founding-only', 'tenant-recipient', 'must fail',
    'owner/repository', 'upgrade', 'codex',
    statement_timestamp(), statement_timestamp() + interval '30 days'
  )" >/dev/null 2>&1; then
  echo 'Cross-tenant sender foreign key unexpectedly succeeded' >&2
  exit 1
fi

echo 'Populated tenant-key migration fixture passed'
