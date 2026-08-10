#!/usr/bin/env bash

set -euo pipefail

admin_url="${MURMUR_VERIFY_ADMIN_DATABASE_URL:-}"
if [ -z "$admin_url" ]; then
  admin_url="$(MURMUR_VERIFY_ADMIN_PASSWORD='murmur_ci_admin_password' bun -e '
    const password = process.env.MURMUR_VERIFY_ADMIN_PASSWORD;
    if (password === undefined) process.exit(1);
    const url = new URL("postgresql://127.0.0.1:5432/postgres?sslmode=disable");
    url.username = "postgres";
    url.password = password;
    process.stdout.write(url.toString());
  ')"
fi
app_password="${MURMUR_VERIFY_APP_PASSWORD:-murmur_ci_runtime_password_with_32_bytes}"
app_url="$(MURMUR_RUNTIME_ADMIN_DATABASE_URL="$admin_url" \
  MURMUR_RUNTIME_DATABASE_TEMPLATE_URL="$admin_url" \
  MURMUR_RUNTIME_PASSWORD="$app_password" \
  bun scripts/provision-runtime-database.ts)"

psql "$admin_url" --set ON_ERROR_STOP=1 --command "
  do \$block\$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
  end;
  \$block\$;
"
bunx supabase db push --db-url "$admin_url" --include-all --yes
invalid_lifecycle_indexes="$(psql "$admin_url" --tuples-only --no-align --quiet \
  --command "select count(*) from pg_catalog.pg_index as index_state join pg_catalog.pg_class as index_class on index_class.oid = index_state.indexrelid join pg_catalog.pg_namespace as index_schema on index_schema.oid = index_class.relnamespace where index_schema.nspname = 'murmur' and index_class.relname in ('messages_recipient_generation_sequence', 'agents_open_activity', 'agents_closed_gc') and not index_state.indisvalid")"
if [ "$invalid_lifecycle_indexes" != '0' ]; then
  echo "Lifecycle migration left $invalid_lifecycle_indexes invalid concurrent indexes" >&2
  exit 1
fi
for recovery_attempt in 1 2; do
  MURMUR_RUNTIME_ADMIN_DATABASE_URL="$admin_url" \
    MURMUR_RUNTIME_DATABASE_CREDENTIAL_URL="$app_url" \
    MURMUR_RUNTIME_APPLY=1 \
    MURMUR_DATABASE_TLS_INSECURE=1 \
    bun scripts/provision-runtime-database.ts
done
unset recovery_attempt

role_probe="$(psql "$app_url" --tuples-only --no-align \
  --command 'select rolsuper, rolbypassrls from pg_roles where rolname = current_user')"
if [ "$role_probe" != 'f|f' ]; then
  echo "murmur_app has unsafe role attributes: $role_probe" >&2
  exit 1
fi
if psql "$app_url" --command 'select count(*) from murmur.operator_tokens' >/dev/null 2>&1; then
  echo 'murmur_app unexpectedly read operator_tokens' >&2
  exit 1
fi

owner_only_calls=(
  "select murmur.configure_operator_bootstrap('51000000-0000-4000-8000-000000000001', 'DeniedKey1', decode(repeat('00', 32), 'hex'))"
  "select murmur.configure_runtime_role_password('denied_runtime_password_with_32_bytes')"
  "select murmur.operator_break_glass_create('51000000-0000-4000-8000-000000000002', 'DeniedKey2', decode(repeat('11', 32), 'hex'), 'Denied break glass', 'permission test')"
  "select murmur.validate_tenant_contract()"
)
for owner_only_call in "${owner_only_calls[@]}"; do
  if psql "$app_url" --set ON_ERROR_STOP=1 --command "$owner_only_call" >/dev/null 2>&1; then
    echo "murmur_app unexpectedly invoked owner-only function: $owner_only_call" >&2
    exit 1
  fi
done

coverage_mode="${MURMUR_VERIFY_COVERAGE:-0}"
case "$coverage_mode" in
  0|1) ;;
  *)
    echo 'MURMUR_VERIFY_COVERAGE must be 0 or 1' >&2
    exit 1
    ;;
esac
if [ "$coverage_mode" = '1' ]; then
  MURMUR_TEST_APP_DATABASE_URL="$app_url" \
    MURMUR_TEST_ADMIN_DATABASE_URL="$admin_url" \
    MURMUR_TEST_BOOTSTRAP_LEGACY_TOKEN='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    MURMUR_TEST_DATABASE_TLS_INSECURE=1 \
    bun run scripts/run-coverage.ts --defer-audit
else
  MURMUR_TEST_APP_DATABASE_URL="$app_url" \
    MURMUR_TEST_ADMIN_DATABASE_URL="$admin_url" \
    MURMUR_TEST_BOOTSTRAP_LEGACY_TOKEN='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    MURMUR_TEST_DATABASE_TLS_INSECURE=1 \
    bun test test/hosted.mcp.e2e.test.ts
fi

psql "$admin_url" --set ON_ERROR_STOP=1 \
  --command 'select murmur.validate_tenant_contract()'

founding_tenant_id='00000000-0000-4000-8000-000000000001'
second_tenant_id="$(psql "$admin_url" --tuples-only --no-align --quiet \
  --command "select tenant_id from murmur.tenants where tenant_id <> '$founding_tenant_id'::uuid order by created_at, tenant_id limit 1")"
if [ -z "$second_tenant_id" ]; then
  echo 'Hosted verification did not create a second tenant for direct RLS probes' >&2
  exit 1
fi
for tenant_table in agents agent_sessions messages broadcasts access_tokens notices orchestrator_policies; do
  expected_rows="$(psql "$admin_url" --tuples-only --no-align --quiet \
    --command "select count(*) from murmur.$tenant_table where tenant_id = '$founding_tenant_id'::uuid")"
  visible_rows="$(psql "$app_url" --tuples-only --no-align --quiet \
    --command "begin; set local murmur.tenant_id = '$founding_tenant_id'; select count(*) from murmur.$tenant_table; rollback;")"
  if [ "$visible_rows" != "$expected_rows" ]; then
    echo "Direct RLS probe exposed the wrong $tenant_table row count: expected $expected_rows, found $visible_rows" >&2
    exit 1
  fi
  no_context_rows="$(psql "$app_url" --tuples-only --no-align --quiet \
    --command "select count(*) from murmur.$tenant_table")"
  if [ "$no_context_rows" != '0' ]; then
    echo "Direct RLS probe exposed $tenant_table rows without tenant context" >&2
    exit 1
  fi
done
if psql "$app_url" --set ON_ERROR_STOP=1 \
  --command "begin;
    set local murmur.tenant_id = '$founding_tenant_id';
    insert into murmur.agents(
      tenant_id, agent_id, display_name, metadata, created_at, last_seen_at
    ) values (
      '$second_tenant_id', 'ci-cross-tenant-write', 'Denied', '{}',
      statement_timestamp(), statement_timestamp()
    );
    rollback;" >/dev/null 2>&1; then
  echo 'murmur_app unexpectedly wrote an agent outside its tenant context' >&2
  exit 1
fi

provenance_tenant_id="$(psql "$admin_url" --tuples-only --no-align --quiet \
  --command "select message.tenant_id
    from murmur.messages as message
    join murmur.agents as agent
      on agent.tenant_id = message.tenant_id and agent.agent_id = message.sender_id
    where agent.authority = 'peer'
    order by message.tenant_id limit 1")"
if [ -z "$provenance_tenant_id" ]; then
  echo 'Hosted verification did not create a peer agent for provenance probes' >&2
  exit 1
fi
if psql "$app_url" --set ON_ERROR_STOP=1 \
  --command "begin;
    set local murmur.tenant_id = '$provenance_tenant_id';
    update murmur.agents
    set authority = 'orchestrator'
    where tenant_id = '$provenance_tenant_id'::uuid
      and agent_id = (
        select agent_id from murmur.agents
        where tenant_id = '$provenance_tenant_id'::uuid and authority = 'peer'
        order by agent_id limit 1
      );
    rollback;" >/dev/null 2>&1; then
  echo 'murmur_app unexpectedly changed stored agent authority' >&2
  exit 1
fi
if psql "$app_url" --set ON_ERROR_STOP=1 \
  --command "begin;
    set local murmur.tenant_id = '$provenance_tenant_id';
    update murmur.messages
    set sender_authority = 'orchestrator'
    where tenant_id = '$provenance_tenant_id'::uuid;
    rollback;" >/dev/null 2>&1; then
  echo 'murmur_app unexpectedly changed stored message provenance' >&2
  exit 1
fi
if psql "$app_url" --set ON_ERROR_STOP=1 \
  --command "begin;
    set local murmur.tenant_id = '$provenance_tenant_id';
    insert into murmur.messages(
      tenant_id, tenant_sequence, message_id, thread_id, sender_id, recipient_id,
      content, created_at, expires_at, sender_authority, message_kind
    )
    select
      '$provenance_tenant_id'::uuid, 999998, pg_catalog.gen_random_uuid(),
      'ci-provenance-spoof', agent_id, agent_id, 'spoofed authority',
      pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp() + interval '30 days',
      'orchestrator', 'message'
    from murmur.agents
    where tenant_id = '$provenance_tenant_id'::uuid and authority = 'peer'
    order by agent_id
    limit 1;
    rollback;" >/dev/null 2>&1; then
  echo 'murmur_app unexpectedly inserted spoofed message authority' >&2
  exit 1
fi
if psql "$app_url" --set ON_ERROR_STOP=1 \
  --command "begin;
    set local murmur.tenant_id = '$provenance_tenant_id';
    insert into murmur.broadcasts(
      tenant_id, broadcast_id, thread_id, sender_id, content,
      repository_name, branch_name, client_name, created_at, expires_at,
      sender_authority
    )
    select
      '$provenance_tenant_id'::uuid, pg_catalog.gen_random_uuid(),
      'ci-broadcast-spoof', agent_id, 'spoofed broadcast authority',
      'ci/provenance', 'ci', 'codex', pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp() + interval '30 days', 'orchestrator'
    from murmur.agents
    where tenant_id = '$provenance_tenant_id'::uuid and authority = 'peer'
    order by agent_id
    limit 1;
    rollback;" >/dev/null 2>&1; then
  echo 'murmur_app unexpectedly inserted spoofed broadcast authority' >&2
  exit 1
fi
unset founding_tenant_id second_tenant_id tenant_table expected_rows visible_rows no_context_rows
unset provenance_tenant_id

assigned_sequence="$(psql "$app_url" \
  --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "begin;
    set local murmur.tenant_id = '00000000-0000-4000-8000-000000000001';
    insert into murmur.agents(
      tenant_id, agent_id, display_name, metadata, created_at, last_seen_at
    ) values
      ('00000000-0000-4000-8000-000000000001', 'ci-sequence-sender', 'CI Sender', '{}', statement_timestamp(), statement_timestamp()),
      ('00000000-0000-4000-8000-000000000001', 'ci-sequence-recipient', 'CI Recipient', '{}', statement_timestamp(), statement_timestamp());
    insert into murmur.messages(
      tenant_id, tenant_sequence, message_id, thread_id, sender_id,
      recipient_id, content, created_at, expires_at, repository_name,
      branch_name, client_name
    ) values (
      '00000000-0000-4000-8000-000000000001', 999999,
      '51000000-0000-4000-8000-000000000003', 'ci-sequence-thread',
      'ci-sequence-sender', 'ci-sequence-recipient', 'sequence probe',
      statement_timestamp(), statement_timestamp() + interval '30 days',
      'owner/repository', 'ci', 'codex'
    );
    select tenant_sequence
    from murmur.messages
    where message_id = '51000000-0000-4000-8000-000000000003';
    rollback;")"
if ! [[ "$assigned_sequence" =~ ^[1-9][0-9]*$ ]] || [ "$assigned_sequence" = '999999' ]; then
  echo "Runtime caller controlled tenant sequence: $assigned_sequence" >&2
  exit 1
fi
if psql "$app_url" --set ON_ERROR_STOP=1 \
  --command 'select murmur.finalize_tenant_contract()' >/dev/null 2>&1; then
  echo 'murmur_app unexpectedly finalized the tenant contract' >&2
  exit 1
fi

bunx supabase db advisors \
  --db-url "$admin_url" \
  --type all \
  --level warn \
  --fail-on error

MURMUR_MIGRATION_TEST_ADMIN_URL="$admin_url" bash scripts/verify-populated-upgrade.sh
if [ "$coverage_mode" = '1' ]; then
  bun run scripts/check-coverage.ts
fi
