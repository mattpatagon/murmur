begin;

set local lock_timeout = '5s';

-- Privilege follows the immutable founding tenant identity, never metadata or a session GUC.
alter table murmur.tenant_resource_usage
  drop constraint tenant_resource_usage_agents_bounded,
  drop constraint tenant_resource_usage_retained_agents_bounded,
  add constraint tenant_resource_usage_agents_bounded check (
    agent_count between 0 and case
      when tenant_id = '00000000-0000-4000-8000-000000000001'::uuid then 10000 else 1000 end
  ),
  add constraint tenant_resource_usage_retained_agents_bounded check (
    retained_agent_count between 0 and case
      when tenant_id = '00000000-0000-4000-8000-000000000001'::uuid then 100000 else 10000 end
  );

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
  retained_limit bigint := case
    when quota_tenant = '00000000-0000-4000-8000-000000000001'::uuid then 100000 else 10000 end;
begin
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

revoke all on function murmur.enforce_tenant_agent_quota()
  from public, anon, authenticated, murmur_app;

commit;
