begin;

alter table murmur.messages
  add column sender_generation integer not null default 1,
  add column recipient_generation integer not null default 1,
  add constraint messages_sender_generation_positive check (sender_generation >= 1),
  add constraint messages_recipient_generation_positive check (recipient_generation >= 1);

alter table murmur.broadcasts
  add column sender_generation integer not null default 1,
  add constraint broadcasts_sender_generation_positive check (sender_generation >= 1);

create index messages_recipient_generation_sequence
  on murmur.messages(tenant_id, recipient_id, recipient_generation, tenant_sequence);

create function murmur.snapshot_message_generations()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  resolved_recipient_generation integer;
  resolved_sender_generation integer;
begin
  select agent.generation
  into resolved_sender_generation
  from murmur.agents as agent
  where agent.tenant_id = new.tenant_id
    and agent.agent_id = new.sender_id;

  select agent.generation
  into resolved_recipient_generation
  from murmur.agents as agent
  where agent.tenant_id = new.tenant_id
    and agent.agent_id = new.recipient_id;

  if resolved_sender_generation is null or resolved_recipient_generation is null then
    raise exception 'message generation snapshot references an unknown agent'
      using errcode = '23503';
  end if;

  new.sender_generation := resolved_sender_generation;
  new.recipient_generation := resolved_recipient_generation;
  return new;
end;
$function$;

create function murmur.snapshot_broadcast_generation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  resolved_sender_generation integer;
begin
  select agent.generation
  into resolved_sender_generation
  from murmur.agents as agent
  where agent.tenant_id = new.tenant_id
    and agent.agent_id = new.sender_id;

  if resolved_sender_generation is null then
    raise exception 'broadcast generation snapshot references an unknown agent'
      using errcode = '23503';
  end if;

  new.sender_generation := resolved_sender_generation;
  return new;
end;
$function$;

revoke all on function murmur.snapshot_message_generations()
  from public, anon, authenticated;
revoke all on function murmur.snapshot_broadcast_generation()
  from public, anon, authenticated;
grant execute on function murmur.snapshot_message_generations() to murmur_app;
grant execute on function murmur.snapshot_broadcast_generation() to murmur_app;

create trigger snapshot_message_generations_before_insert
before insert on murmur.messages
for each row
execute function murmur.snapshot_message_generations();

create trigger snapshot_broadcast_generation_before_insert
before insert on murmur.broadcasts
for each row
execute function murmur.snapshot_broadcast_generation();

commit;
