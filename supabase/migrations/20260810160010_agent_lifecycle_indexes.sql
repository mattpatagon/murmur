set lock_timeout = '5s';

do $validation$
begin
  if exists (
    select 1
    from pg_catalog.pg_class as index_class
    join pg_catalog.pg_namespace as index_schema
      on index_schema.oid = index_class.relnamespace
    join pg_catalog.pg_index as index_state
      on index_state.indexrelid = index_class.oid
    where index_schema.nspname = 'murmur'
      and index_class.relname = 'agents_open_activity'
      and not index_state.indisvalid
  ) then
    drop index murmur.agents_open_activity;
  end if;
end;
$validation$;

create index concurrently if not exists agents_open_activity
  on murmur.agents(tenant_id, last_seen_at desc, agent_id)
  where closed_at is null;

do $validation$
begin
  if exists (
    select 1
    from pg_catalog.pg_class as index_class
    join pg_catalog.pg_namespace as index_schema
      on index_schema.oid = index_class.relnamespace
    join pg_catalog.pg_index as index_state
      on index_state.indexrelid = index_class.oid
    where index_schema.nspname = 'murmur'
      and index_class.relname = 'agents_closed_gc'
      and not index_state.indisvalid
  ) then
    drop index murmur.agents_closed_gc;
  end if;
end;
$validation$;

create index concurrently if not exists agents_closed_gc
  on murmur.agents(tenant_id, closed_at, agent_id)
  where closed_at is not null;

reset lock_timeout;
