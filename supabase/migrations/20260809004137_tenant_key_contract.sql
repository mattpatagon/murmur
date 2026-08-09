begin;

create table murmur.tenant_message_sequences (
  tenant_id uuid primary key references murmur.tenants(tenant_id),
  last_sequence bigint not null,
  constraint tenant_message_sequences_nonnegative check (last_sequence >= 0)
);

create table murmur.tenant_resource_usage (
  tenant_id uuid primary key references murmur.tenants(tenant_id),
  agent_count bigint not null,
  access_token_count bigint not null,
  message_count bigint not null,
  message_content_bytes bigint not null,
  broadcast_count bigint not null,
  broadcast_content_bytes bigint not null,
  constraint tenant_resource_usage_agents_bounded
    check (agent_count between 0 and 1000),
  constraint tenant_resource_usage_access_tokens_bounded
    check (access_token_count between 0 and 1000),
  constraint tenant_resource_usage_messages_bounded
    check (message_count between 0 and 100000),
  constraint tenant_resource_usage_content_bounded
    check (message_content_bytes between 0 and 268435456),
  constraint tenant_resource_usage_broadcasts_bounded
    check (broadcast_count between 0 and 10000),
  constraint tenant_resource_usage_broadcast_content_bounded
    check (broadcast_content_bytes between 0 and 67108864)
);

alter table murmur.tenant_resource_usage enable row level security;

insert into murmur.tenant_resource_usage(
  tenant_id,
  agent_count,
  access_token_count,
  message_count,
  message_content_bytes,
  broadcast_count,
  broadcast_content_bytes
)
select
  tenant.tenant_id,
  (
    select pg_catalog.count(*)
    from murmur.agents as agent
    where agent.tenant_id = tenant.tenant_id
  ),
  (
    select pg_catalog.count(*)
    from murmur.access_tokens as access_token
    where access_token.tenant_id = tenant.tenant_id
  ),
  (
    select pg_catalog.count(*)
    from murmur.messages as message
    where message.tenant_id = tenant.tenant_id
  ),
  (
    select coalesce(pg_catalog.sum(pg_catalog.octet_length(message.content)), 0::bigint)
    from murmur.messages as message
    where message.tenant_id = tenant.tenant_id
  ),
  (
    select pg_catalog.count(*)
    from murmur.broadcasts as broadcast
    where broadcast.tenant_id = tenant.tenant_id
  ),
  (
    select coalesce(pg_catalog.sum(pg_catalog.octet_length(broadcast.content)), 0::bigint)
    from murmur.broadcasts as broadcast
    where broadcast.tenant_id = tenant.tenant_id
  )
from murmur.tenants as tenant;

revoke all on table murmur.tenant_resource_usage
  from public, anon, authenticated, murmur_app;

create function murmur.initialize_tenant_resource_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into murmur.tenant_resource_usage(
    tenant_id,
    agent_count,
    access_token_count,
    message_count,
    message_content_bytes,
    broadcast_count,
    broadcast_content_bytes
  ) values (new.tenant_id, 0, 0, 0, 0, 0, 0);
  return new;
end;
$function$;

create function murmur.enforce_tenant_access_token_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    update murmur.tenant_resource_usage as usage
    set access_token_count = usage.access_token_count + 1
    where usage.tenant_id = new.tenant_id
      and usage.access_token_count < 1000;
    if not found then
      raise exception 'tenant access-token quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  update murmur.tenant_resource_usage as usage
  set access_token_count = greatest(usage.access_token_count - 1, 0)
  where usage.tenant_id = old.tenant_id;
  return old;
end;
$function$;

create function murmur.enforce_tenant_agent_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    update murmur.tenant_resource_usage as usage
    set agent_count = usage.agent_count + 1
    where usage.tenant_id = new.tenant_id
      and usage.agent_count < 1000;
    if not found then
      raise exception 'tenant agent quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  update murmur.tenant_resource_usage as usage
  set agent_count = greatest(usage.agent_count - 1, 0)
  where usage.tenant_id = old.tenant_id;
  return old;
end;
$function$;

create function murmur.enforce_tenant_message_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected_tenants integer;
  requested_tenants integer;
begin
  if tg_op = 'INSERT' then
    select pg_catalog.count(*)
    into requested_tenants
    from (
      select inserted.tenant_id
      from inserted_rows as inserted
      group by inserted.tenant_id
    ) as requested;

    update murmur.tenant_resource_usage as usage
    set
      message_count = usage.message_count + delta.message_count,
      message_content_bytes = usage.message_content_bytes + delta.content_bytes
    from (
      select
        inserted.tenant_id,
        pg_catalog.count(*) as message_count,
        pg_catalog.sum(pg_catalog.octet_length(inserted.content)) as content_bytes
      from inserted_rows as inserted
      group by inserted.tenant_id
    ) as delta
    where usage.tenant_id = delta.tenant_id
      and usage.message_count + delta.message_count <= 100000
      and usage.message_content_bytes + delta.content_bytes <= 268435456;
    get diagnostics affected_tenants = row_count;
    if affected_tenants <> requested_tenants then
      raise exception 'tenant retained-message quota exceeded' using errcode = '54000';
    end if;
    return null;
  end if;

  update murmur.tenant_resource_usage as usage
  set
    message_count = greatest(usage.message_count - delta.message_count, 0),
    message_content_bytes = greatest(
      usage.message_content_bytes - delta.content_bytes,
      0
    )
  from (
    select
      deleted.tenant_id,
      pg_catalog.count(*) as message_count,
      pg_catalog.sum(pg_catalog.octet_length(deleted.content)) as content_bytes
    from deleted_rows as deleted
    group by deleted.tenant_id
  ) as delta
  where usage.tenant_id = delta.tenant_id;
  return null;
end;
$function$;

create function murmur.enforce_tenant_broadcast_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  content_bytes bigint;
begin
  if tg_op = 'INSERT' then
    content_bytes := pg_catalog.octet_length(new.content);
    update murmur.tenant_resource_usage as usage
    set
      broadcast_count = usage.broadcast_count + 1,
      broadcast_content_bytes = usage.broadcast_content_bytes + content_bytes
    where usage.tenant_id = new.tenant_id
      and usage.broadcast_count < 10000
      and usage.broadcast_content_bytes + content_bytes <= 67108864;
    if not found then
      raise exception 'tenant retained-broadcast quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  content_bytes := pg_catalog.octet_length(old.content);
  update murmur.tenant_resource_usage as usage
  set
    broadcast_count = greatest(usage.broadcast_count - 1, 0),
    broadcast_content_bytes = greatest(
      usage.broadcast_content_bytes - content_bytes,
      0
    )
  where usage.tenant_id = old.tenant_id;
  return old;
end;
$function$;

revoke all on function murmur.enforce_tenant_access_token_quota()
  from public, anon, authenticated;
revoke all on function murmur.enforce_tenant_agent_quota()
  from public, anon, authenticated;
revoke all on function murmur.enforce_tenant_broadcast_quota()
  from public, anon, authenticated;
revoke all on function murmur.enforce_tenant_message_quota()
  from public, anon, authenticated;
revoke all on function murmur.initialize_tenant_resource_usage()
  from public, anon, authenticated;
grant execute on function murmur.enforce_tenant_agent_quota() to murmur_app;
grant execute on function murmur.enforce_tenant_access_token_quota() to murmur_app;
grant execute on function murmur.enforce_tenant_broadcast_quota() to murmur_app;
grant execute on function murmur.enforce_tenant_message_quota() to murmur_app;
grant execute on function murmur.initialize_tenant_resource_usage() to murmur_app;

create trigger initialize_tenant_resource_usage_after_insert
after insert on murmur.tenants
for each row
execute function murmur.initialize_tenant_resource_usage();

create trigger enforce_tenant_agent_quota_change
after insert or delete on murmur.agents
for each row
execute function murmur.enforce_tenant_agent_quota();

create trigger enforce_tenant_access_token_quota_change
after insert or delete on murmur.access_tokens
for each row
execute function murmur.enforce_tenant_access_token_quota();

create trigger enforce_tenant_broadcast_quota_change
after insert or delete on murmur.broadcasts
for each row
execute function murmur.enforce_tenant_broadcast_quota();

create trigger enforce_tenant_message_insert_quota
after insert on murmur.messages
referencing new table as inserted_rows
for each statement
execute function murmur.enforce_tenant_message_quota();

create trigger release_tenant_message_delete_quota
after delete on murmur.messages
referencing old table as deleted_rows
for each statement
execute function murmur.enforce_tenant_message_quota();

alter table murmur.tenant_message_sequences enable row level security;
alter table murmur.tenant_message_sequences force row level security;

revoke all on table murmur.tenant_message_sequences from public, anon, authenticated;
grant select, insert, update on table murmur.tenant_message_sequences to murmur_app;

create policy tenant_message_sequences_current_tenant
on murmur.tenant_message_sequences
for all
to murmur_app
using (
  tenant_id = nullif(
    (select pg_catalog.current_setting('murmur.tenant_id', true)),
    ''
  )::uuid
)
with check (
  tenant_id = nullif(
    (select pg_catalog.current_setting('murmur.tenant_id', true)),
    ''
  )::uuid
);

create function murmur.assign_tenant_message_sequence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  allocated_sequence bigint;
begin
  if new.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
    and not murmur.tenant_onboarding_enabled()
  then
    insert into murmur.tenant_message_sequences as counter(tenant_id, last_sequence)
    values (new.tenant_id, new.sequence)
    on conflict (tenant_id) do update
    set last_sequence = greatest(counter.last_sequence, excluded.last_sequence);
    new.tenant_sequence := new.sequence;
    return new;
  end if;

  insert into murmur.tenant_message_sequences as counter(tenant_id, last_sequence)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update
  set last_sequence = counter.last_sequence + 1
  returning last_sequence into allocated_sequence;

  new.tenant_sequence := allocated_sequence;
  return new;
end;
$function$;

revoke all on function murmur.assign_tenant_message_sequence()
  from public, anon, authenticated;
grant execute on function murmur.assign_tenant_message_sequence() to murmur_app;

lock table murmur.messages in share row exclusive mode;

insert into murmur.tenant_message_sequences(tenant_id, last_sequence)
select
  tenant.tenant_id,
  sequence_state.last_value
from murmur.tenants as tenant
cross join murmur.messages_sequence_seq as sequence_state
where exists (
  select 1
  from murmur.messages as message
  where message.tenant_id = tenant.tenant_id
);

alter table murmur.messages add column tenant_sequence bigint;

create trigger assign_tenant_message_sequence_before_insert
before insert on murmur.messages
for each row
execute function murmur.assign_tenant_message_sequence();

commit;
