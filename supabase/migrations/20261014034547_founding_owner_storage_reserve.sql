begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- The migration owner explicitly enables priority at deployment. Runtime roles cannot
-- change limits or counters; tiny disposable test budgets retain their existing contracts.
alter table murmur.hosted_storage_budget
  add column owner_reserve_enabled boolean not null default false,
  add column owner_reserved_rows bigint not null default 100000
    check (owner_reserved_rows between 0 and 1000000000),
  add column owner_reserved_bytes bigint not null default 268435456
    check (owner_reserved_bytes between 0 and 1125899906842624),
  add column owner_rows bigint not null default 0 check (owner_rows >= 0),
  add column owner_bytes bigint not null default 0 check (owner_bytes >= 0);

create function murmur.adjust_hosted_storage_budget_with_owner_reserve(
  p_table text, p_rows bigint, p_bytes bigint, p_restrictive_audit boolean,
  p_owner_rows bigint, p_owner_bytes bigint
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
  audit_row_limit bigint;
  audit_byte_limit bigint;
begin
  if p_table is null or not p_table = any(murmur.hosted_storage_tables())
    or p_rows is null or p_bytes is null or p_restrictive_audit is null
    or p_owner_rows is null or p_owner_bytes is null
    or (p_table = 'admin_audit' and (p_owner_rows <> 0 or p_owner_bytes <> 0))
    or (p_restrictive_audit and p_table <> 'admin_audit') then
    raise exception 'hosted storage accounting input is invalid' using errcode = 'XX001';
  end if;
  if p_rows = 0 and p_bytes = 0 and p_owner_rows = 0 and p_owner_bytes = 0 then return; end if;

  select * into strict current_budget
  from murmur.hosted_storage_budget where singleton_id = 1 for update;
  if current_budget.retained_rows + data_rows < 0
    or current_budget.accounted_bytes + data_bytes < 0
    or current_budget.feedback_rows + delta_feedback_rows < 0
    or current_budget.feedback_bytes + delta_feedback_bytes < 0
    or current_budget.audit_rows + delta_audit_rows < 0
    or current_budget.audit_bytes + delta_audit_bytes < 0
    or current_budget.owner_rows + p_owner_rows < 0
    or current_budget.owner_bytes + p_owner_bytes < 0
    or current_budget.owner_rows + p_owner_rows > current_budget.retained_rows + data_rows
    or current_budget.owner_bytes + p_owner_bytes > current_budget.accounted_bytes + data_bytes then
    raise exception 'hosted storage accounting is inconsistent' using errcode = 'XX001';
  end if;

  audit_row_limit := current_budget.max_audit_rows;
  audit_byte_limit := current_budget.max_audit_bytes;
  if not p_restrictive_audit then
    -- Ordinary work cannot consume the final quarter reserved for audited restrictions.
    -- A deliberately tiny owner limit still reserves at least one row/byte without raising it.
    audit_row_limit := audit_row_limit - greatest(1::bigint, audit_row_limit / 4);
    audit_byte_limit := audit_byte_limit - greatest(1::bigint, audit_byte_limit / 4);
  end if;

  update murmur.hosted_storage_budget as budget set
    retained_rows = budget.retained_rows + data_rows,
    accounted_bytes = budget.accounted_bytes + data_bytes,
    feedback_rows = budget.feedback_rows + delta_feedback_rows,
    feedback_bytes = budget.feedback_bytes + delta_feedback_bytes,
    audit_rows = budget.audit_rows + delta_audit_rows,
    audit_bytes = budget.audit_bytes + delta_audit_bytes,
    owner_rows = budget.owner_rows + p_owner_rows,
    owner_bytes = budget.owner_bytes + p_owner_bytes
  where budget.singleton_id = 1
    and (data_rows <= 0 or budget.retained_rows + data_rows <= budget.max_rows)
    and (data_bytes <= 0 or budget.accounted_bytes + data_bytes <= budget.max_bytes)
    -- The owner can consume its reserve and unused shared space, always under the global ceiling.
    -- Others cannot consume the reserved slice even when the owner is currently idle.
    and (not budget.owner_reserve_enabled or data_rows - p_owner_rows <= 0
      or budget.retained_rows + data_rows - budget.owner_rows - p_owner_rows
        <= greatest(0::bigint, budget.max_rows - budget.owner_reserved_rows))
    and (not budget.owner_reserve_enabled or data_bytes - p_owner_bytes <= 0
      or budget.accounted_bytes + data_bytes - budget.owner_bytes - p_owner_bytes
        <= greatest(0::bigint, budget.max_bytes - budget.owner_reserved_bytes))
    and (delta_feedback_rows <= 0
      or budget.feedback_rows + delta_feedback_rows <= budget.max_feedback_rows)
    and (delta_feedback_bytes <= 0
      or budget.feedback_bytes + delta_feedback_bytes <= budget.max_feedback_bytes)
    and (delta_audit_rows <= 0 or budget.audit_rows + delta_audit_rows <= audit_row_limit)
    and (delta_audit_bytes <= 0 or budget.audit_bytes + delta_audit_bytes <= audit_byte_limit);
  if not found then
    raise exception 'hosted retained-storage capacity reached' using errcode = '54000';
  end if;
end;
$function$;


create or replace function murmur.adjust_hosted_storage_budget_with_audit_headroom(
  p_table text, p_rows bigint, p_bytes bigint, p_restrictive_audit boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform murmur.adjust_hosted_storage_budget_with_owner_reserve(
    p_table, p_rows, p_bytes, p_restrictive_audit, 0, 0
  );
end;
$function$;

create or replace function murmur.account_hosted_storage_change()
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
  restrictive_audit boolean := false;
  added_owner_rows bigint := 0;
  added_owner_bytes bigint := 0;
  removed_owner_rows bigint := 0;
  removed_owner_bytes bigint := 0;
begin
  if tg_table_schema <> 'murmur' or not tg_table_name = any(murmur.hosted_storage_tables()) then
    raise exception 'hosted storage accounting input is invalid' using errcode = 'XX001';
  end if;
  if tg_relid = 'murmur.tenant_resource_usage'::regclass
    and tg_op = 'UPDATE' and tg_when = 'AFTER' and tg_level = 'STATEMENT'
    and exists (
      select 1 from pg_catalog.pg_attribute as column_shape
      where column_shape.attrelid = tg_relid
        and column_shape.attnum > 0 and not column_shape.attisdropped
        and column_shape.attname = 'tenant_id'
        and column_shape.atttypid = 'pg_catalog.uuid'::regtype
        and column_shape.attnotnull
    )
    and not exists (
      select 1 from pg_catalog.pg_attribute as column_shape
      where column_shape.attrelid = tg_relid
        and column_shape.attnum > 0 and not column_shape.attisdropped
        and not (
          (column_shape.attname = 'tenant_id'
            and column_shape.atttypid = 'pg_catalog.uuid'::regtype
            and column_shape.attnotnull)
          or (column_shape.attname <> 'tenant_id'
            and column_shape.atttypid in (
              'pg_catalog.int2'::regtype, 'pg_catalog.int4'::regtype, 'pg_catalog.int8'::regtype
            ))
        )
    ) then
    if (select count(*) from hosted_new_rows as stored
      where stored.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid)
      = (select count(*) from hosted_old_rows as stored
        where stored.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid) then
      -- UPDATE has equal old/new cardinality. This shape charges every row exactly
      -- 512 + 9 (tenant_id key) + 38 (quoted UUID) bytes; integral values are uncharged.
      -- Any added or retyped charged field fails the catalog guard and uses the full path.
      return null;
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select pg_catalog.count(*),
      coalesce(pg_catalog.sum(murmur.hosted_storage_row_bytes(pg_catalog.to_jsonb(stored))), 0)
    into added_rows, added_bytes from hosted_new_rows as stored;
    if tg_table_name <> 'admin_audit' then
      select count(*), coalesce(sum(murmur.hosted_storage_row_bytes(to_jsonb(stored))), 0)
      into added_owner_rows, added_owner_bytes from hosted_new_rows as stored
      where to_jsonb(stored)->>'tenant_id' = '00000000-0000-4000-8000-000000000001';
    end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select pg_catalog.count(*),
      coalesce(pg_catalog.sum(murmur.hosted_storage_row_bytes(pg_catalog.to_jsonb(stored))), 0)
    into removed_rows, removed_bytes from hosted_old_rows as stored;
    if tg_table_name <> 'admin_audit' then
      select count(*), coalesce(sum(murmur.hosted_storage_row_bytes(to_jsonb(stored))), 0)
      into removed_owner_rows, removed_owner_bytes from hosted_old_rows as stored
      where to_jsonb(stored)->>'tenant_id' = '00000000-0000-4000-8000-000000000001';
    end if;
  end if;
  if tg_table_name = 'admin_audit' and tg_op = 'INSERT' then
    -- Runtime callers cannot write this table or supply action names to its trusted writers.
    -- Every row must be restrictive: mixed batches and all UPDATE growth remain ordinary.
    select coalesce(pg_catalog.bool_and(stored.action in (
      'tenant.suspend', 'operator_token.revoke'
    )), false) into restrictive_audit from hosted_new_rows as stored;
  end if;
  if added_owner_rows = removed_owner_rows and added_owner_bytes = removed_owner_bytes then
    perform murmur.adjust_hosted_storage_budget_with_audit_headroom(
      tg_table_name, added_rows - removed_rows, added_bytes - removed_bytes, restrictive_audit
    );
  else
    perform murmur.adjust_hosted_storage_budget_with_owner_reserve(
      tg_table_name, added_rows - removed_rows, added_bytes - removed_bytes, restrictive_audit,
      added_owner_rows - removed_owner_rows, added_owner_bytes - removed_owner_bytes
    );
  end if;
  return null;
end;
$function$;


create or replace function murmur.reconcile_hosted_storage_budget()
returns void
language plpgsql
security definer
set search_path = ''
set bytea_output = 'hex'
as $function$
declare
  table_name text;
  row_total bigint;
  byte_total bigint;
  data_rows bigint := 0;
  data_bytes bigint := 0;
  measured_feedback_rows bigint := 0;
  measured_feedback_bytes bigint := 0;
  measured_audit_rows bigint := 0;
  measured_audit_bytes bigint := 0;
  measured_owner_rows bigint := 0;
  measured_owner_bytes bigint := 0;
  table_owner_rows bigint;
  table_owner_bytes bigint;
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  foreach table_name in array murmur.hosted_storage_tables() loop
    execute pg_catalog.format('lock table murmur.%I in share row exclusive mode', table_name);
  end loop;
  foreach table_name in array murmur.hosted_storage_tables() loop
    execute pg_catalog.format(
      'select count(*), coalesce(sum(murmur.hosted_storage_row_bytes(to_jsonb(stored))), 0) '
      'from murmur.%I as stored', table_name
    ) into row_total, byte_total;
    if table_name = 'admin_audit' then
      measured_audit_rows := row_total;
      measured_audit_bytes := byte_total;
    else
      execute pg_catalog.format(
        'select count(*), coalesce(sum(murmur.hosted_storage_row_bytes(to_jsonb(stored))), 0) '
        'from murmur.%I as stored where to_jsonb(stored)->>''tenant_id'' = $1', table_name
      ) into table_owner_rows, table_owner_bytes
        using '00000000-0000-4000-8000-000000000001';
      measured_owner_rows := measured_owner_rows + table_owner_rows;
      measured_owner_bytes := measured_owner_bytes + table_owner_bytes;
      data_rows := data_rows + row_total;
      data_bytes := data_bytes + byte_total;
      if table_name = 'feedback_submissions' then
        measured_feedback_rows := row_total;
        measured_feedback_bytes := byte_total;
      end if;
    end if;
  end loop;
  -- Preserve both existing data and operator-selected limits, including an overfull upgrade.
  update murmur.hosted_storage_budget as budget set
    retained_rows = data_rows,
    accounted_bytes = data_bytes,
    feedback_rows = measured_feedback_rows,
    feedback_bytes = measured_feedback_bytes,
    audit_rows = measured_audit_rows,
    audit_bytes = measured_audit_bytes,
    owner_rows = measured_owner_rows,
    owner_bytes = measured_owner_bytes
  where budget.singleton_id = 1;
  if not found then
    raise exception 'hosted storage budget is unavailable' using errcode = 'XX001';
  end if;
end;
$function$;

create or replace function murmur.account_hosted_storage_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
set bytea_output = 'hex'
as $function$
declare
  removed_rows bigint;
  removed_bytes bigint;
  removed_owner_rows bigint := 0;
  removed_owner_bytes bigint := 0;
begin
  if tg_table_schema <> 'murmur'
    or not tg_table_name = any(murmur.hosted_storage_tables()) then
    raise exception 'hosted storage accounting input is invalid' using errcode = 'XX001';
  end if;
  execute pg_catalog.format(
    'select count(*), coalesce(sum(murmur.hosted_storage_row_bytes(to_jsonb(stored))), 0) '
    'from murmur.%I as stored', tg_table_name
  ) into removed_rows, removed_bytes;
  if tg_table_name <> 'admin_audit' then
    execute pg_catalog.format(
      'select count(*), coalesce(sum(murmur.hosted_storage_row_bytes(to_jsonb(stored))), 0) '
      'from murmur.%I as stored where to_jsonb(stored)->>''tenant_id'' = $1', tg_table_name
    ) into removed_owner_rows, removed_owner_bytes
      using '00000000-0000-4000-8000-000000000001';
  end if;
  perform murmur.adjust_hosted_storage_budget_with_owner_reserve(
    tg_table_name, -removed_rows, -removed_bytes, false, -removed_owner_rows, -removed_owner_bytes
  );
  return null;
end;
$function$;


-- Existing triggers remain mandatory; deriving ownership from actual transition rows also
-- handles mixed-tenant maintenance batches, deletes, updates and transaction rollback.
revoke all on function murmur.adjust_hosted_storage_budget_with_owner_reserve(
  text, bigint, bigint, boolean, bigint, bigint
) from public, anon, authenticated, murmur_app;
revoke all on function murmur.adjust_hosted_storage_budget_with_audit_headroom(
  text, bigint, bigint, boolean
) from public, anon, authenticated, murmur_app;

select murmur.reconcile_hosted_storage_budget();

commit;
