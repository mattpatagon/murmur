begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

create function murmur.retire_owner_agent_for_capacity(p_tenant uuid, p_incoming_agent text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate record;
  locked_sessions bigint;
  active_sessions bigint;
  retirement_time timestamptz := pg_catalog.statement_timestamp();
begin
  if p_tenant is distinct from '00000000-0000-4000-8000-000000000001'::uuid
    or p_incoming_agent is null or pg_catalog.char_length(p_incoming_agent) not between 1 and 200 then
    raise exception 'owner retirement input is invalid' using errcode = 'XX001';
  end if;

  -- Preserve retained rows and message generations. Dormant reopening within the same
  -- repository already restores the original generation through the lifecycle writer.
  for candidate in
    select agent.agent_id from murmur.agents as agent
    where agent.tenant_id = p_tenant and agent.closed_at is null
      and agent.agent_id <> p_incoming_agent
      and not exists (
        select 1 from murmur.access_tokens as token
        where token.tenant_id = agent.tenant_id and token.token_role = 'orchestrator'
          and token.orchestrator_agent_id = agent.agent_id and token.revoked_at is null
          and (token.expires_at is null or token.expires_at > retirement_time)
      )
    order by agent.last_seen_at, agent.agent_id collate "C"
    limit 16 for update of agent skip locked
  loop
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      p_tenant::text || ':orchestrator:' || candidate.agent_id, 0
    )) or not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      p_tenant::text || ':' || candidate.agent_id, 671255459461899938::bigint
    )) then continue; end if;
    if exists (
      select 1 from murmur.access_tokens as token
      where token.tenant_id = p_tenant and token.token_role = 'orchestrator'
        and token.orchestrator_agent_id = candidate.agent_id and token.revoked_at is null
        and (token.expires_at is null or token.expires_at > retirement_time)
    ) then continue; end if;

    -- Existing identity writers use the advisory lock, but skip locked leases as well
    -- so a direct maintenance transaction cannot invert the quota/identity lock order.
    perform 1 from murmur.agent_sessions as session
    where session.tenant_id = p_tenant and session.agent_id = candidate.agent_id
      and session.ended_at is null
    order by session.generation, session.session_key collate "C"
    limit 65 for update skip locked;
    get diagnostics locked_sessions = row_count;
    select count(*) into active_sessions from (
      select 1 from murmur.agent_sessions as session
      where session.tenant_id = p_tenant and session.agent_id = candidate.agent_id
        and session.ended_at is null limit 65
    ) as bounded;
    if active_sessions > 64 or locked_sessions <> active_sessions then continue; end if;

    update murmur.agent_sessions set ended_at = retirement_time, end_reason = 'closed'
    where tenant_id = p_tenant and agent_id = candidate.agent_id and ended_at is null;
    update murmur.agents set closed_at = retirement_time, close_reason = 'dormant'
    where tenant_id = p_tenant and agent_id = candidate.agent_id and closed_at is null;
    if found then return true; end if;
  end loop;
  -- Saturation stays explicit when all bounded candidates are busy or protected.
  return false;
end;
$function$;

create or replace function murmur.enforce_tenant_agent_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  quota_tenant uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
  open_limit bigint := case
    when quota_tenant = '00000000-0000-4000-8000-000000000001'::uuid then 10000 else 1000 end;
  current_open_count bigint;
  current_retained_count bigint;
  retained_limit bigint := case
    when quota_tenant = '00000000-0000-4000-8000-000000000001'::uuid then 100000 else 10000 end;
begin
  if quota_tenant = '00000000-0000-4000-8000-000000000001'::uuid
    and ((tg_op = 'INSERT' and new.closed_at is null)
      or (tg_op = 'UPDATE' and old.closed_at is not null and new.closed_at is null)) then
    -- Serialize the decision with the unchanged quota counter lock. Candidate locks below
    -- never wait, because ordinary writers take their identity lock before this counter.
    select agent_count, retained_agent_count into strict current_open_count, current_retained_count
    from murmur.tenant_resource_usage where tenant_id = quota_tenant for update;
    if current_open_count >= open_limit
      and (tg_op <> 'INSERT' or current_retained_count < retained_limit) then
      perform murmur.retire_owner_agent_for_capacity(quota_tenant, new.agent_id);
    end if;
  end if;

  if tg_op = 'INSERT' then
    update murmur.tenant_resource_usage as usage
    set
      agent_count = usage.agent_count + case when new.closed_at is null then 1 else 0 end,
      retained_agent_count = usage.retained_agent_count + 1
    where usage.tenant_id = new.tenant_id
      and usage.retained_agent_count < retained_limit
      and (new.closed_at is not null or usage.agent_count < open_limit);
    if not found then
      if exists (
        select 1 from murmur.tenant_resource_usage as usage
        where usage.tenant_id = new.tenant_id and usage.retained_agent_count >= retained_limit
      ) then
        raise exception 'tenant retained-agent quota exceeded' using errcode = '54000';
      end if;
      raise exception 'tenant agent quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.closed_at is not null and new.closed_at is null then
    update murmur.tenant_resource_usage as usage
    set agent_count = usage.agent_count + 1
    where usage.tenant_id = new.tenant_id
      and usage.agent_count < open_limit;
    if not found then
      raise exception 'tenant agent quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.closed_at is null and new.closed_at is not null then
    update murmur.tenant_resource_usage as usage
    set agent_count = usage.agent_count - 1
    where usage.tenant_id = old.tenant_id and usage.agent_count > 0;
    if not found then
      raise exception 'tenant agent quota accounting inconsistent' using errcode = 'XX001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    update murmur.tenant_resource_usage as usage
    set
      agent_count = usage.agent_count - case when old.closed_at is null then 1 else 0 end,
      retained_agent_count = usage.retained_agent_count - 1
    where usage.tenant_id = old.tenant_id
      and usage.retained_agent_count > 0
      and (old.closed_at is not null or usage.agent_count > 0);
    if not found then
      raise exception 'tenant agent quota accounting inconsistent' using errcode = 'XX001';
    end if;
    return old;
  end if;

  return new;
end;
$function$;

revoke all on function murmur.retire_owner_agent_for_capacity(uuid, text)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.enforce_tenant_agent_quota()
  from public, anon, authenticated, murmur_app;

commit;
