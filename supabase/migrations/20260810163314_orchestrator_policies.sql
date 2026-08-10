begin;

create table murmur.orchestrator_policies (
  policy_id uuid primary key default pg_catalog.gen_random_uuid(),
  tenant_id uuid not null references murmur.tenants(tenant_id),
  scope_kind text not null,
  scope_owner_id uuid not null,
  repository_name text not null default '',
  orchestrator_token_id uuid not null,
  instructions text not null,
  enabled boolean not null default true,
  created_by_token_id uuid not null,
  updated_by_token_id uuid not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint orchestrator_policies_scope_kind_allowed
    check (scope_kind in ('organization', 'personal')),
  constraint orchestrator_policies_scope_owner_consistent check (
    scope_kind <> 'organization' or scope_owner_id = tenant_id
  ),
  constraint orchestrator_policies_repository_format check (
    repository_name = ''
    or (
      char_length(repository_name) between 3 and 500
      and repository_name ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$'
    )
  ),
  constraint orchestrator_policies_instructions_bounded check (
    pg_catalog.octet_length(instructions) between 1 and 8192
  ),
  constraint orchestrator_policies_tenant_token_fkey
    foreign key (tenant_id, orchestrator_token_id)
    references murmur.access_tokens(tenant_id, token_id),
  constraint orchestrator_policies_tenant_policy_unique
    unique (tenant_id, policy_id),
  constraint orchestrator_policies_scope_unique
    unique (tenant_id, scope_kind, scope_owner_id, repository_name)
);

create index orchestrator_policies_resolution
  on murmur.orchestrator_policies(
    tenant_id,
    enabled,
    scope_kind,
    scope_owner_id,
    repository_name
  );

alter table murmur.messages
  add constraint messages_orchestrator_policy_fkey
    foreign key (tenant_id, orchestrator_policy_id)
    references murmur.orchestrator_policies(tenant_id, policy_id)
    not valid;

alter table murmur.messages
  validate constraint messages_orchestrator_policy_fkey;

alter table murmur.orchestrator_policies enable row level security;
alter table murmur.orchestrator_policies force row level security;

revoke all on table murmur.orchestrator_policies
  from public, anon, authenticated;
grant select, insert, update on table murmur.orchestrator_policies to murmur_app;

create policy orchestrator_policies_current_tenant
on murmur.orchestrator_policies
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

create function murmur.enforce_orchestrator_policy_quota()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_count bigint;
begin
  if exists (
    select 1
    from murmur.orchestrator_policies as policy
    where policy.tenant_id = new.tenant_id
      and policy.scope_kind = new.scope_kind
      and policy.scope_owner_id = new.scope_owner_id
      and policy.repository_name = new.repository_name
  ) then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.tenant_id::text || ':orchestrator_policies', 0)
  );
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

revoke all on function murmur.enforce_orchestrator_policy_quota()
  from public, anon, authenticated;
grant execute on function murmur.enforce_orchestrator_policy_quota() to murmur_app;

create trigger enforce_orchestrator_policy_quota_before_insert
before insert on murmur.orchestrator_policies
for each row
execute function murmur.enforce_orchestrator_policy_quota();

create or replace function murmur.operator_mint_tenant_admin_token(
  p_operator_secret_hash bytea,
  p_tenant_id uuid,
  p_token_id uuid,
  p_key_id text,
  p_secret_hash bytea,
  p_token_name text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_token_id uuid;
  actor_key_id text;
  tenant_status text;
begin
  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  select status
  into tenant_status
  from murmur.tenants
  where tenant_id = p_tenant_id
  for update;

  if tenant_status is null then
    raise exception 'tenant unavailable' using errcode = 'P0002';
  end if;

  if tenant_status = 'suspended' then
    update murmur.access_tokens
    set revoked_at = coalesce(revoked_at, pg_catalog.statement_timestamp())
    where tenant_id = p_tenant_id;
  end if;

  delete from murmur.access_tokens as token
  where token.tenant_id = p_tenant_id
    and (
      token.revoked_at is not null
      or token.expires_at <= pg_catalog.statement_timestamp()
    )
    and not exists (
      select 1
      from murmur.orchestrator_policies as policy
      where policy.tenant_id = token.tenant_id
        and policy.orchestrator_token_id = token.token_id
    );

  insert into murmur.access_tokens(
    token_id, tenant_id, key_id, secret_hash, token_role, name, expires_at
  ) values (
    p_token_id,
    p_tenant_id,
    p_key_id,
    p_secret_hash,
    'tenant_admin',
    p_token_name,
    p_expires_at
  );

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id,
    metadata
  ) values (
    actor_token_id,
    actor_key_id,
    'tenant_admin_token.create',
    'tenant',
    p_tenant_id::text,
    pg_catalog.jsonb_build_object('token_id', p_token_id, 'key_id', p_key_id)
  );
end;
$function$;

commit;
