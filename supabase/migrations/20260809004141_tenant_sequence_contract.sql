begin;

alter table murmur.messages alter column tenant_sequence set not null;

alter table murmur.messages
  add constraint messages_tenant_broadcast_fkey
    foreign key (tenant_id, broadcast_id)
    references murmur.broadcasts(tenant_id, broadcast_id)
    on delete cascade
    not valid;

create or replace function murmur.notify_inbox_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_notify(
    'murmur_inbox_changed',
    case
      when new.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid then
        pg_catalog.json_build_object(
          'agent_id', new.recipient_id,
          'sequence', new.tenant_sequence
        )::text
      else
        pg_catalog.json_build_object(
          'tenant_id', new.tenant_id,
          'agent_id', new.recipient_id,
          'sequence', new.tenant_sequence
        )::text
    end
  );
  return new;
end;
$function$;

commit;
