begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

create table murmur.hosted_storage_budget (
  singleton_id integer primary key default 1 check (singleton_id = 1),
  retained_rows bigint not null default 0 check (retained_rows >= 0),
  accounted_bytes bigint not null default 0 check (accounted_bytes >= 0),
  feedback_rows bigint not null default 0 check (feedback_rows >= 0),
  feedback_bytes bigint not null default 0 check (feedback_bytes >= 0),
  audit_rows bigint not null default 0 check (audit_rows >= 0),
  audit_bytes bigint not null default 0 check (audit_bytes >= 0),
  max_rows bigint not null default 2000000 check (max_rows between 1 and 1000000000),
  max_bytes bigint not null default 4294967296
    check (max_bytes between 1 and 1125899906842624),
  max_feedback_rows bigint not null default 50000
    check (max_feedback_rows between 1 and 1000000000),
  max_feedback_bytes bigint not null default 134217728
    check (max_feedback_bytes between 1 and 1125899906842624),
  max_audit_rows bigint not null default 100000
    check (max_audit_rows between 1 and 1000000000),
  max_audit_bytes bigint not null default 67108864
    check (max_audit_bytes between 1 and 1125899906842624)
);

insert into murmur.hosted_storage_budget(singleton_id) values (1);

alter table murmur.hosted_storage_budget enable row level security;
alter table murmur.hosted_storage_budget force row level security;
revoke all on table murmur.hosted_storage_budget
  from public, anon, authenticated, murmur_app;

create function murmur.hosted_storage_tables()
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $function$
  select array[
    'access_tokens', 'admin_audit', 'agent_sessions', 'agents', 'bootstrap_state',
    'broadcasts', 'e2ee_broadcast_deliveries', 'e2ee_broadcasts', 'e2ee_claims',
    'e2ee_key_bundles', 'e2ee_messages', 'e2ee_prekeys', 'feedback_submissions',
    'messages', 'notices', 'operator_tokens', 'orchestrator_policies', 'platform_state',
    'self_service_registration_state', 'tenant_e2ee_state', 'tenant_e2ee_usage',
    'tenant_message_sequences', 'tenant_resource_usage', 'tenants'
  ]::text[];
$function$;

create function murmur.hosted_storage_row_bytes(p_row jsonb)
returns bigint
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  -- Reserve bounded scalars before nullable lifecycle fields become populated.
  -- JSON payloads remain charged even when their work is consumed or cancelled.
  select 512::bigint + coalesce(pg_catalog.sum(
    pg_catalog.octet_length(field.key) + pg_catalog.octet_length(field.value::text)
  ), 0::bigint)
  from pg_catalog.jsonb_each(p_row) as field
  where pg_catalog.jsonb_typeof(field.value) in ('string', 'object', 'array')
    and field.key <> all(array[
      'created_at', 'updated_at', 'expires_at', 'read_at', 'last_seen_at',
      'started_at', 'last_renewed_at', 'lease_expires_at', 'ended_at', 'closed_at',
      'revoked_at', 'last_used_at', 'suspended_at', 'configured_at', 'completed_at',
      'legacy_imported_at', 'runtime_role_provisioned_at', 'window_started_at',
      'published_at', 'claimed_at', 'retired_at', 'consumed_at', 'accepted_at',
      'committed_at', 'resolved_at', 'withdrawn_at', 'status', 'state', 'end_reason',
      'close_reason', 'token_role', 'authority', 'sender_authority', 'message_kind',
      'client_name', 'scope_kind', 'kind', 'submission_type', 'prekey_class',
      'resolved_by_id', 'withdrawn_by_id'
    ]::text[]);
$function$;

create function murmur.adjust_hosted_storage_budget(
  p_table text, p_rows bigint, p_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  data_rows bigint := case when p_table = 'admin_audit' then 0 else p_rows end;
  data_bytes bigint := case when p_table = 'admin_audit' then 0 else p_bytes end;
  delta_feedback_rows bigint := case when p_table = 'feedback_submissions' then p_rows else 0 end;
  delta_feedback_bytes bigint := case when p_table = 'feedback_submissions' then p_bytes else 0 end;
  delta_audit_rows bigint := case when p_table = 'admin_audit' then p_rows else 0 end;
  delta_audit_bytes bigint := case when p_table = 'admin_audit' then p_bytes else 0 end;
  current_budget murmur.hosted_storage_budget%rowtype;
begin
  if p_table is null or not p_table = any(murmur.hosted_storage_tables())
    or p_rows is null or p_bytes is null then
    raise exception 'hosted storage accounting input is invalid' using errcode = 'XX001';
  end if;
  if p_rows = 0 and p_bytes = 0 then return; end if;

  select * into strict current_budget
  from murmur.hosted_storage_budget where singleton_id = 1 for update;
  if current_budget.retained_rows + data_rows < 0
    or current_budget.accounted_bytes + data_bytes < 0
    or current_budget.feedback_rows + delta_feedback_rows < 0
    or current_budget.feedback_bytes + delta_feedback_bytes < 0
    or current_budget.audit_rows + delta_audit_rows < 0
    or current_budget.audit_bytes + delta_audit_bytes < 0 then
    raise exception 'hosted storage accounting is inconsistent' using errcode = 'XX001';
  end if;

  update murmur.hosted_storage_budget as budget set
    retained_rows = budget.retained_rows + data_rows,
    accounted_bytes = budget.accounted_bytes + data_bytes,
    feedback_rows = budget.feedback_rows + delta_feedback_rows,
    feedback_bytes = budget.feedback_bytes + delta_feedback_bytes,
    audit_rows = budget.audit_rows + delta_audit_rows,
    audit_bytes = budget.audit_bytes + delta_audit_bytes
  where budget.singleton_id = 1
    and (data_rows <= 0 or budget.retained_rows + data_rows <= budget.max_rows)
    and (data_bytes <= 0 or budget.accounted_bytes + data_bytes <= budget.max_bytes)
    and (delta_feedback_rows <= 0
      or budget.feedback_rows + delta_feedback_rows <= budget.max_feedback_rows)
    and (delta_feedback_bytes <= 0
      or budget.feedback_bytes + delta_feedback_bytes <= budget.max_feedback_bytes)
    and (delta_audit_rows <= 0 or budget.audit_rows + delta_audit_rows <= budget.max_audit_rows)
    and (delta_audit_bytes <= 0 or budget.audit_bytes + delta_audit_bytes <= budget.max_audit_bytes);
  if not found then
    raise exception 'hosted retained-storage capacity reached' using errcode = '54000';
  end if;
end;
$function$;

create function murmur.account_hosted_storage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
set bytea_output = 'hex'
as $function$
declare
  added_rows bigint := 0;
  added_bytes bigint := 0;
  removed_rows bigint := 0;
  removed_bytes bigint := 0;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select pg_catalog.count(*),
      coalesce(pg_catalog.sum(murmur.hosted_storage_row_bytes(pg_catalog.to_jsonb(stored))), 0)
    into added_rows, added_bytes from hosted_new_rows as stored;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select pg_catalog.count(*),
      coalesce(pg_catalog.sum(murmur.hosted_storage_row_bytes(pg_catalog.to_jsonb(stored))), 0)
    into removed_rows, removed_bytes from hosted_old_rows as stored;
  end if;
  perform murmur.adjust_hosted_storage_budget(
    tg_table_name, added_rows - removed_rows, added_bytes - removed_bytes
  );
  return null;
end;
$function$;

revoke all on function murmur.hosted_storage_tables()
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.hosted_storage_row_bytes(jsonb)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.adjust_hosted_storage_budget(text, bigint, bigint)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.account_hosted_storage_change()
  from public, anon, authenticated, murmur_app;

commit;
