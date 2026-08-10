begin;

set local lock_timeout = '5s';

alter table murmur.agents
  add column generation integer not null default 1,
  add column closed_at timestamptz,
  add column close_reason text,
  add constraint agents_generation_positive check (generation >= 1),
  add constraint agents_close_reason_known check (
    close_reason is null or close_reason in (
      'completed', 'workspace_deleted', 'superseded', 'manual', 'dormant'
    )
  ),
  add constraint agents_closure_consistent check (
    (closed_at is null) = (close_reason is null)
  );

create table murmur.agent_sessions (
  tenant_id uuid not null,
  agent_id text not null,
  generation integer not null,
  session_key text not null,
  started_at timestamptz not null,
  last_renewed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  primary key (tenant_id, agent_id, generation, session_key),
  constraint agent_sessions_tenant_agent_fkey foreign key (tenant_id, agent_id)
    references murmur.agents(tenant_id, agent_id) on delete cascade,
  constraint agent_sessions_generation_positive check (generation >= 1),
  constraint agent_sessions_key_format check (
    char_length(session_key) between 1 and 64
    and session_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  constraint agent_sessions_end_reason_known check (
    end_reason is null or end_reason in (
      'stop', 'session_end', 'superseded', 'expired', 'closed'
    )
  ),
  constraint agent_sessions_end_consistent check (
    (ended_at is null) = (end_reason is null)
  ),
  constraint agent_sessions_lease_order check (
    started_at <= last_renewed_at and last_renewed_at < lease_expires_at
  )
);

create index agent_sessions_live_lease
  on murmur.agent_sessions(tenant_id, agent_id, generation, lease_expires_at desc)
  where ended_at is null;

create index agents_open_activity
  on murmur.agents(tenant_id, last_seen_at desc, agent_id)
  where closed_at is null;

create index agents_closed_gc
  on murmur.agents(tenant_id, closed_at, agent_id)
  where closed_at is not null;

insert into murmur.agent_sessions(
  tenant_id,
  agent_id,
  generation,
  session_key,
  started_at,
  last_renewed_at,
  lease_expires_at
)
select
  tenant_id,
  agent_id,
  generation,
  'backfill',
  last_seen_at,
  last_seen_at,
  last_seen_at + interval '60 minutes'
from murmur.agents
where last_seen_at >= pg_catalog.statement_timestamp() - interval '60 minutes';

alter table murmur.agent_sessions enable row level security;
alter table murmur.agent_sessions force row level security;

revoke all on table murmur.agent_sessions from public, anon, authenticated;
grant select, insert, update, delete on table murmur.agent_sessions to murmur_app;

create policy agent_sessions_current_tenant
on murmur.agent_sessions
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

-- A fresh installation has not yet run the deferred tenant-key finalizer. The
-- lifecycle foreign key therefore initially depends on the compatibility
-- unique index that the finalizer removes. Rebind it to the promoted primary
-- key inside the same transaction so both fresh installs and already-finalized
-- production databases retain referential integrity.
create or replace function murmur.finalize_tenant_contract()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);

  if exists (
    select 1
    from murmur.platform_state as state
    where state.singleton_id = 1
      and state.tenant_contract_version >= 2
  ) then
    return false;
  end if;

  alter table murmur.agent_sessions
    drop constraint agent_sessions_tenant_agent_fkey;

  alter table murmur.messages
    drop constraint messages_sender_id_fkey,
    drop constraint messages_recipient_id_fkey,
    drop constraint messages_broadcast_id_fkey,
    drop constraint messages_sender_idempotency,
    drop constraint messages_tenant_sender_fkey,
    drop constraint messages_tenant_recipient_fkey;

  alter table murmur.broadcasts
    drop constraint broadcasts_sender_id_fkey,
    drop constraint broadcasts_sender_idempotency,
    drop constraint broadcasts_tenant_sender_fkey;

  alter table murmur.agents drop constraint agents_pkey;
  alter table murmur.agents
    add constraint agents_pkey
    primary key using index agents_tenant_agent_primary;
  alter table murmur.agents drop constraint agents_tenant_agent_unique;

  alter table murmur.agent_sessions
    add constraint agent_sessions_tenant_agent_fkey
      foreign key (tenant_id, agent_id)
      references murmur.agents(tenant_id, agent_id)
      on delete cascade
      not valid;

  alter table murmur.messages
    add constraint messages_tenant_sender_fkey
      foreign key (tenant_id, sender_id)
      references murmur.agents(tenant_id, agent_id)
      not valid,
    add constraint messages_tenant_recipient_fkey
      foreign key (tenant_id, recipient_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;

  alter table murmur.broadcasts
    add constraint broadcasts_tenant_sender_fkey
      foreign key (tenant_id, sender_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;

  alter table murmur.agents alter column tenant_id drop default;
  alter table murmur.messages alter column tenant_id drop default;
  alter table murmur.broadcasts alter column tenant_id drop default;

  update murmur.platform_state
  set tenant_contract_version = 2
  where singleton_id = 1;

  return true;
end;
$function$;

create or replace function murmur.validate_tenant_contract()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);

  if not exists (
    select 1
    from murmur.platform_state as state
    where state.singleton_id = 1
      and state.tenant_contract_version >= 2
  ) then
    raise exception 'tenant contract must be finalized before validation'
      using errcode = '55000';
  end if;

  alter table murmur.agent_sessions
    validate constraint agent_sessions_tenant_agent_fkey;
  alter table murmur.messages validate constraint messages_tenant_sender_fkey;
  alter table murmur.messages validate constraint messages_tenant_recipient_fkey;
  alter table murmur.broadcasts validate constraint broadcasts_tenant_sender_fkey;
end;
$function$;

drop trigger enforce_tenant_agent_quota_change on murmur.agents;

create or replace function murmur.enforce_tenant_agent_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected_tenant uuid;
begin
  if tg_op = 'INSERT' and new.closed_at is null then
    update murmur.tenant_resource_usage as usage
    set agent_count = usage.agent_count + 1
    where usage.tenant_id = new.tenant_id
      and usage.agent_count < 1000;
    if not found then
      raise exception 'tenant agent quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.closed_at is not null and new.closed_at is null then
    update murmur.tenant_resource_usage as usage
    set agent_count = usage.agent_count + 1
    where usage.tenant_id = new.tenant_id
      and usage.agent_count < 1000;
    if not found then
      raise exception 'tenant agent quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.closed_at is null and new.closed_at is not null then
    affected_tenant := old.tenant_id;
  elsif tg_op = 'DELETE' and old.closed_at is null then
    affected_tenant := old.tenant_id;
  else
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  update murmur.tenant_resource_usage as usage
  set agent_count = usage.agent_count - 1
  where usage.tenant_id = affected_tenant
    and usage.agent_count > 0;
  if not found then
    raise exception 'tenant agent quota accounting inconsistent' using errcode = 'XX001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create trigger enforce_tenant_agent_quota_change
after insert or delete or update of closed_at on murmur.agents
for each row
execute function murmur.enforce_tenant_agent_quota();

update murmur.tenant_resource_usage as usage
set agent_count = (
  select pg_catalog.count(*)
  from murmur.agents as agent
  where agent.tenant_id = usage.tenant_id
    and agent.closed_at is null
);

commit;
