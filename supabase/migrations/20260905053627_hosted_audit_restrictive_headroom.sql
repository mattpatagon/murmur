begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

create function murmur.adjust_hosted_storage_budget_with_audit_headroom(
  p_table text, p_rows bigint, p_bytes bigint, p_restrictive_audit boolean
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
    or (p_restrictive_audit and p_table <> 'admin_audit') then
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
    audit_bytes = budget.audit_bytes + delta_audit_bytes
  where budget.singleton_id = 1
    and (data_rows <= 0 or budget.retained_rows + data_rows <= budget.max_rows)
    and (data_bytes <= 0 or budget.accounted_bytes + data_bytes <= budget.max_bytes)
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

create or replace function murmur.adjust_hosted_storage_budget(
  p_table text, p_rows bigint, p_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform murmur.adjust_hosted_storage_budget_with_audit_headroom(p_table, p_rows, p_bytes, false);
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
  if tg_table_name = 'admin_audit' and tg_op = 'INSERT' then
    -- Runtime callers cannot write this table or supply action names to its trusted writers.
    -- Every row must be restrictive: mixed batches and all UPDATE growth remain ordinary.
    select coalesce(pg_catalog.bool_and(stored.action in (
      'tenant.suspend', 'operator_token.revoke'
    )), false) into restrictive_audit from hosted_new_rows as stored;
  end if;
  perform murmur.adjust_hosted_storage_budget_with_audit_headroom(
    tg_table_name, added_rows - removed_rows, added_bytes - removed_bytes, restrictive_audit
  );
  return null;
end;
$function$;

revoke all on function murmur.adjust_hosted_storage_budget_with_audit_headroom(text, bigint, bigint, boolean)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.adjust_hosted_storage_budget(text, bigint, bigint)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.account_hosted_storage_change()
  from public, anon, authenticated, murmur_app;

commit;
