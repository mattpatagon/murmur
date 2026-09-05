begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

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
    -- UPDATE has equal old/new cardinality. This shape charges every row exactly
    -- 512 + 9 (tenant_id key) + 38 (quoted UUID) bytes; integral values are uncharged.
    -- Any added or retyped charged field fails the catalog guard and uses the full path.
    return null;
  end if;

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

-- Existing triggers still fire; callers cannot attach these definers to their own tables.
revoke all on function murmur.enforce_tenant_agent_quota()
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.enforce_tenant_access_token_quota()
  from public, anon, authenticated, murmur_app;

commit;
