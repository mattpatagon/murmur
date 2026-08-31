begin;

create table murmur.self_service_registration_state (
  singleton_id integer primary key default 1,
  window_started_at timestamptz not null default pg_catalog.statement_timestamp(),
  registration_count integer not null default 0,
  constraint self_service_registration_state_singleton check (singleton_id = 1),
  constraint self_service_registration_count_bounded check (
    registration_count between 0 and 60
  )
);

insert into murmur.self_service_registration_state(singleton_id) values (1);

alter table murmur.self_service_registration_state enable row level security;
alter table murmur.self_service_registration_state force row level security;

revoke all on table murmur.self_service_registration_state
  from public, anon, authenticated, murmur_app;

create function murmur.self_service_create_tenant(
  p_tenant_id uuid,
  p_slug text,
  p_display_name text,
  p_token_id uuid,
  p_key_id text,
  p_secret_hash bytea
)
returns table(
  tenant_id uuid,
  slug text,
  display_name text,
  status text,
  created_at timestamptz,
  suspended_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing_tenant murmur.tenants%rowtype;
  existing_token murmur.access_tokens%rowtype;
  registered_at timestamptz := pg_catalog.statement_timestamp();
  registration_state murmur.self_service_registration_state%rowtype;
  retained_tenants bigint;
begin
  perform pg_catalog.set_config('lock_timeout', '2s', true);

  if not murmur.tenant_onboarding_enabled() then
    raise exception 'tenant self-service registration is unavailable'
      using errcode = '55000';
  end if;

  select state.*
  into strict registration_state
  from murmur.self_service_registration_state as state
  where state.singleton_id = 1
  for update;

  select token.*
  into existing_token
  from murmur.access_tokens as token
  where token.secret_hash = p_secret_hash;

  if found then
    select tenant.*
    into strict existing_tenant
    from murmur.tenants as tenant
    where tenant.tenant_id = existing_token.tenant_id;

    if existing_tenant.tenant_id is distinct from p_tenant_id
      or existing_tenant.slug is distinct from p_slug
      or existing_tenant.display_name is distinct from p_display_name
      or existing_token.token_id is distinct from p_token_id
      or existing_token.key_id is distinct from p_key_id
      or existing_token.token_role is distinct from 'tenant_admin'
      or existing_token.name is distinct from 'Initial tenant administrator'
      or existing_token.personal_id is distinct from p_token_id
      or existing_token.revoked_at is not null then
      raise exception 'registration secret replay conflicts with its original request'
        using errcode = 'P4090';
    end if;

    return query
    select
      existing_tenant.tenant_id,
      existing_tenant.slug,
      existing_tenant.display_name,
      existing_tenant.status,
      existing_tenant.created_at,
      existing_tenant.suspended_at;
    return;
  end if;

  if registered_at >= registration_state.window_started_at + interval '1 minute' then
    update murmur.self_service_registration_state
    set window_started_at = registered_at,
        registration_count = 1
    where singleton_id = 1;
  elsif registration_state.registration_count >= 60 then
    raise exception 'tenant self-service registration rate exceeded'
      using errcode = 'P4290';
  else
    update murmur.self_service_registration_state
    set registration_count = registration_count + 1
    where singleton_id = 1;
  end if;

  select pg_catalog.count(*)
  into retained_tenants
  from murmur.tenants;
  if retained_tenants >= 100000 then
    raise exception 'tenant self-service capacity reached'
      using errcode = 'P5030';
  end if;

  insert into murmur.tenants(tenant_id, slug, display_name)
  values (p_tenant_id, p_slug, p_display_name);

  insert into murmur.access_tokens(
    token_id, tenant_id, key_id, secret_hash, token_role, name
  ) values (
    p_token_id,
    p_tenant_id,
    p_key_id,
    p_secret_hash,
    'tenant_admin',
    'Initial tenant administrator'
  );

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id, metadata
  ) values (
    '00000000-0000-0000-0000-000000000000',
    'self_service',
    'tenant.self_service_create',
    'tenant',
    p_tenant_id::text,
    pg_catalog.jsonb_build_object('slug', p_slug, 'display_name', p_display_name)
  );

  return query
  select
    tenant.tenant_id,
    tenant.slug,
    tenant.display_name,
    tenant.status,
    tenant.created_at,
    tenant.suspended_at
  from murmur.tenants as tenant
  where tenant.tenant_id = p_tenant_id;
end;
$function$;

revoke all on function murmur.self_service_create_tenant(
  uuid, text, text, uuid, text, bytea
) from public, anon, authenticated;

grant execute on function murmur.self_service_create_tenant(
  uuid, text, text, uuid, text, bytea
) to murmur_app;

commit;
