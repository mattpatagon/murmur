begin;

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
  foreign key (tenant_id, agent_id)
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
