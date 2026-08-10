begin;

set local lock_timeout = '5s';

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

create index agent_sessions_ended_cleanup
  on murmur.agent_sessions(tenant_id, ended_at, agent_id, generation, session_key)
  where ended_at is not null;

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

commit;
