begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

create function murmur.reconcile_hosted_storage_budget()
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
    audit_bytes = measured_audit_bytes
  where budget.singleton_id = 1;
  if not found then
    raise exception 'hosted storage budget is unavailable' using errcode = 'XX001';
  end if;
end;
$function$;

create function murmur.account_hosted_storage_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
set bytea_output = 'hex'
as $function$
declare
  removed_rows bigint;
  removed_bytes bigint;
begin
  if tg_table_schema <> 'murmur'
    or not tg_table_name = any(murmur.hosted_storage_tables()) then
    raise exception 'hosted storage accounting input is invalid' using errcode = 'XX001';
  end if;
  execute pg_catalog.format(
    'select count(*), coalesce(sum(murmur.hosted_storage_row_bytes(to_jsonb(stored))), 0) '
    'from murmur.%I as stored', tg_table_name
  ) into removed_rows, removed_bytes;
  perform murmur.adjust_hosted_storage_budget(tg_table_name, -removed_rows, -removed_bytes);
  return null;
end;
$function$;

revoke all on function murmur.reconcile_hosted_storage_budget()
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.account_hosted_storage_truncate()
  from public, anon, authenticated, murmur_app;

select murmur.reconcile_hosted_storage_budget();

do $block$
declare
  table_name text;
begin
  foreach table_name in array murmur.hosted_storage_tables() loop
    execute pg_catalog.format(
      'create trigger account_hosted_storage_insert after insert on murmur.%I '
      'referencing new table as hosted_new_rows for each statement '
      'execute function murmur.account_hosted_storage_change()', table_name
    );
    execute pg_catalog.format(
      'create trigger account_hosted_storage_update after update on murmur.%I '
      'referencing old table as hosted_old_rows new table as hosted_new_rows '
      'for each statement execute function murmur.account_hosted_storage_change()', table_name
    );
    execute pg_catalog.format(
      'create trigger account_hosted_storage_delete after delete on murmur.%I '
      'referencing old table as hosted_old_rows for each statement '
      'execute function murmur.account_hosted_storage_change()', table_name
    );
    execute pg_catalog.format(
      'create trigger account_hosted_storage_truncate before truncate on murmur.%I '
      'for each statement execute function murmur.account_hosted_storage_truncate()', table_name
    );
  end loop;
end;
$block$;

create function murmur.hosted_storage_budget_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (select 1 from murmur.hosted_storage_budget where singleton_id = 1)
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'murmur.hosted_storage_budget'::regclass
        and relrowsecurity and relforcerowsecurity
    )
    and not exists (
      select 1 from pg_catalog.pg_class as relation
      where relation.relnamespace = 'murmur'::regnamespace
        and relation.relkind in ('r', 'p')
        and relation.relname <> 'hosted_storage_budget'
        and not relation.relname = any(murmur.hosted_storage_tables())
    )
    and not exists (
      select 1 from pg_catalog.unnest(murmur.hosted_storage_tables()) as expected_table(table_name)
      cross join (values
        ('account_hosted_storage_insert', 4, 'murmur.account_hosted_storage_change()',
          null::text, 'hosted_new_rows'),
        ('account_hosted_storage_update', 16, 'murmur.account_hosted_storage_change()',
          'hosted_old_rows', 'hosted_new_rows'),
        ('account_hosted_storage_delete', 8, 'murmur.account_hosted_storage_change()',
          'hosted_old_rows', null::text),
        ('account_hosted_storage_truncate', 34, 'murmur.account_hosted_storage_truncate()',
          null::text, null::text)
      ) as expected_trigger(trigger_name, trigger_type, trigger_function, old_table, new_table)
      left join pg_catalog.pg_class as relation
        on relation.relnamespace = 'murmur'::regnamespace
        and relation.relname = expected_table.table_name and relation.relkind = 'r'
      left join pg_catalog.pg_trigger as actual
        on actual.tgrelid = relation.oid and actual.tgname = expected_trigger.trigger_name
      where actual.oid is null or actual.tgenabled not in ('O', 'A')
        or actual.tgtype <> expected_trigger.trigger_type
        or actual.tgfoid is distinct from pg_catalog.to_regprocedure(expected_trigger.trigger_function)
        or actual.tgoldtable is distinct from expected_trigger.old_table
        or actual.tgnewtable is distinct from expected_trigger.new_table
        or actual.tgnargs <> 0 or actual.tgqual is not null
    );
$function$;

revoke all on function murmur.hosted_storage_budget_ready()
  from public, anon, authenticated, murmur_app;
grant execute on function murmur.hosted_storage_budget_ready() to murmur_app;

commit;
