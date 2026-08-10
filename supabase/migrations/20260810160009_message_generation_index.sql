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
      and index_class.relname = 'messages_recipient_generation_sequence'
      and not index_state.indisvalid
  ) then
    drop index murmur.messages_recipient_generation_sequence;
  end if;
end;
$validation$;

create index concurrently if not exists messages_recipient_generation_sequence
  on murmur.messages(tenant_id, recipient_id, recipient_generation, tenant_sequence);

reset lock_timeout;
