begin;

set local lock_timeout = '5s';

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
    and agent.agent_id = new.sender_id
    and agent.closed_at is null
  for share;

  select agent.generation
  into resolved_recipient_generation
  from murmur.agents as agent
  where agent.tenant_id = new.tenant_id
    and agent.agent_id = new.recipient_id
    and agent.closed_at is null
  for share;

  if resolved_sender_generation is null or resolved_recipient_generation is null then
    raise exception 'message generation snapshot references an unknown or closed agent'
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
    and agent.agent_id = new.sender_id
    and agent.closed_at is null
  for share;

  if resolved_sender_generation is null then
    raise exception 'broadcast generation snapshot references an unknown or closed agent'
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
