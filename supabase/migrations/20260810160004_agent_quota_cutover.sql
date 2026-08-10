begin;

set local lock_timeout = '5s';

drop trigger enforce_tenant_agent_quota_change on murmur.agents;

create or replace function murmur.enforce_tenant_agent_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    update murmur.tenant_resource_usage as usage
    set
      agent_count = usage.agent_count + case when new.closed_at is null then 1 else 0 end,
      retained_agent_count = usage.retained_agent_count + 1
    where usage.tenant_id = new.tenant_id
      and usage.retained_agent_count < 10000
      and (new.closed_at is not null or usage.agent_count < 1000);
    if not found then
      if exists (
        select 1 from murmur.tenant_resource_usage as usage
        where usage.tenant_id = new.tenant_id and usage.retained_agent_count >= 10000
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
      and usage.agent_count < 1000;
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

create trigger enforce_tenant_agent_quota_change
after insert or delete or update of closed_at on murmur.agents
for each row
execute function murmur.enforce_tenant_agent_quota();

-- Before lifecycle writers exist every retained agent is open, so the existing
-- open-agent counter is also the exact retained count. The trigger swap locks
-- agent writes while this O(number of tenants) initialization runs.
update murmur.tenant_resource_usage
set retained_agent_count = agent_count;

commit;
