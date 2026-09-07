begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

alter table murmur.access_tokens
  add column machine_name text,
  add constraint access_tokens_machine_format check (
    machine_name is null
    or (
      char_length(machine_name) between 1 and 200
      and machine_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    )
  ) not valid;

alter table murmur.access_tokens
  validate constraint access_tokens_machine_format;

alter table murmur.orchestrator_policies
  add column machine_name text not null default '',
  add constraint orchestrator_policies_machine_format check (
    machine_name = ''
    or (
      char_length(machine_name) between 1 and 200
      and machine_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    )
  ) not valid;

alter table murmur.orchestrator_policies
  validate constraint orchestrator_policies_machine_format;

create or replace function murmur.enforce_orchestrator_policy_quota()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_count bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.tenant_id::text || ':orchestrator_policies', 0)
  );
  if exists (
    select 1
    from murmur.orchestrator_policies as policy
    where policy.tenant_id = new.tenant_id
      and policy.scope_kind = new.scope_kind
      and policy.scope_owner_id = new.scope_owner_id
      and policy.repository_name = new.repository_name
      and policy.machine_name = new.machine_name
  ) then
    return new;
  end if;
  select pg_catalog.count(*)
  into current_count
  from murmur.orchestrator_policies as policy
  where policy.tenant_id = new.tenant_id;
  if current_count >= 1000 then
    raise exception 'tenant orchestrator-policy quota exceeded' using errcode = '54000';
  end if;
  return new;
end;
$function$;

create function murmur.authenticate_principal_v3(p_secret_hash bytea)
returns table(
  principal_kind text,
  token_id uuid,
  key_id text,
  tenant_id uuid,
  token_role text,
  personal_id uuid,
  repository_name text,
  machine_name text,
  orchestrator_agent_id text
)
language sql
security definer
volatile
rows 1
set search_path = ''
as $function$
  select
    authenticated.principal_kind,
    authenticated.token_id,
    authenticated.key_id,
    authenticated.tenant_id,
    authenticated.token_role,
    authenticated.personal_id,
    authenticated.repository_name,
    token.machine_name,
    authenticated.orchestrator_agent_id
  from murmur.authenticate_principal_v2(p_secret_hash) as authenticated
  left join murmur.access_tokens as token
    on authenticated.principal_kind = 'tenant'
    and token.tenant_id = authenticated.tenant_id
    and token.token_id = authenticated.token_id;
$function$;

revoke all on function murmur.authenticate_principal_v3(bytea)
  from public, anon, authenticated;
grant execute on function murmur.authenticate_principal_v3(bytea) to murmur_app;

commit;
