set lock_timeout = '5s';
set statement_timeout = '15min';

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
      and index_class.relname = 'orchestrator_policies_scope_machine_unique'
      and not index_state.indisvalid
  ) then
    drop index murmur.orchestrator_policies_scope_machine_unique;
  end if;
end;
$validation$;

create unique index concurrently if not exists orchestrator_policies_scope_machine_unique
  on murmur.orchestrator_policies(
    tenant_id,
    scope_kind,
    scope_owner_id,
    repository_name,
    machine_name
  );

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
      and index_class.relname = 'orchestrator_policies_resolution_machine'
      and not index_state.indisvalid
  ) then
    drop index murmur.orchestrator_policies_resolution_machine;
  end if;
end;
$validation$;

create index concurrently if not exists orchestrator_policies_resolution_machine
  on murmur.orchestrator_policies(
    tenant_id,
    enabled,
    scope_kind,
    scope_owner_id,
    repository_name,
    machine_name
  );

reset statement_timeout;
reset lock_timeout;
