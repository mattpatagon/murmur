begin;

create index access_tokens_tenant_created
  on murmur.access_tokens(tenant_id, created_at desc, token_id desc);

create index access_tokens_active_hash
  on murmur.access_tokens(secret_hash)
  where revoked_at is null;

create index operator_tokens_active_hash
  on murmur.operator_tokens(secret_hash)
  where revoked_at is null;

create index operator_tokens_created
  on murmur.operator_tokens(created_at desc, token_id desc);

create index tenants_created
  on murmur.tenants(created_at, tenant_id);

create index admin_audit_created
  on murmur.admin_audit(created_at desc, audit_id desc);

alter table murmur.tenants enable row level security;
alter table murmur.tenants force row level security;
alter table murmur.platform_state enable row level security;
alter table murmur.platform_state force row level security;
alter table murmur.access_tokens enable row level security;
alter table murmur.access_tokens force row level security;
alter table murmur.operator_tokens enable row level security;
alter table murmur.operator_tokens force row level security;
alter table murmur.bootstrap_state enable row level security;
alter table murmur.bootstrap_state force row level security;
alter table murmur.admin_audit enable row level security;
alter table murmur.admin_audit force row level security;
alter table murmur.agents enable row level security;
alter table murmur.agents force row level security;
alter table murmur.messages enable row level security;
alter table murmur.messages force row level security;
alter table murmur.broadcasts enable row level security;
alter table murmur.broadcasts force row level security;

revoke all on table murmur.tenants from public, anon, authenticated;
revoke all on table murmur.platform_state from public, anon, authenticated;
revoke all on table murmur.access_tokens from public, anon, authenticated;
revoke all on table murmur.operator_tokens from public, anon, authenticated;
revoke all on table murmur.bootstrap_state from public, anon, authenticated;
revoke all on table murmur.admin_audit from public, anon, authenticated;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'murmur_app') then
    create role murmur_app login noinherit nosuperuser nocreatedb nocreaterole noreplication;
  end if;
end;
$block$;

grant usage on schema murmur to murmur_app;
grant select on table murmur.tenants to murmur_app;
grant select, insert, delete on table murmur.access_tokens to murmur_app;
grant update(revoked_at, last_used_at) on table murmur.access_tokens to murmur_app;
grant select, insert, update, delete on table murmur.agents to murmur_app;
grant select, insert, update, delete on table murmur.messages to murmur_app;
grant select, insert, update, delete on table murmur.broadcasts to murmur_app;
grant usage, select on sequence murmur.messages_sequence_seq to murmur_app;

create policy tenants_select_current
on murmur.tenants
for select
to murmur_app
using (
  tenant_id = nullif(
    (select pg_catalog.current_setting('murmur.tenant_id', true)),
    ''
  )::uuid
);

create policy access_tokens_current_tenant
on murmur.access_tokens
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

create policy agents_current_tenant
on murmur.agents
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

create policy messages_current_tenant
on murmur.messages
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

create policy broadcasts_current_tenant
on murmur.broadcasts
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

create or replace function murmur.notify_inbox_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_notify(
    'murmur_inbox_changed',
    case
      when new.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid then
        pg_catalog.json_build_object(
          'agent_id', new.recipient_id,
          'sequence', new.sequence
        )::text
      else
        pg_catalog.json_build_object(
          'tenant_id', new.tenant_id,
          'agent_id', new.recipient_id,
          'sequence', new.sequence
        )::text
    end
  );
  return new;
end;
$function$;

create function murmur.authenticate_principal(p_secret_hash bytea)
returns table(
  principal_kind text,
  token_id uuid,
  key_id text,
  tenant_id uuid,
  token_role text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return query
  select
    'bootstrap'::text,
    state.bootstrap_token_id,
    state.bootstrap_key_id,
    null::uuid,
    null::text
  from murmur.bootstrap_state as state
  where state.completed_at is null
    and state.expected_secret_hash = p_secret_hash;

  if found then
    return;
  end if;

  return query
  update murmur.operator_tokens as token
  set last_used_at = pg_catalog.statement_timestamp()
  where token.secret_hash = p_secret_hash
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
    and (
      token.last_used_at is null
      or token.last_used_at < pg_catalog.statement_timestamp() - interval '5 minutes'
    )
  returning
    'operator'::text,
    token.token_id,
    token.key_id,
    null::uuid,
    null::text;

  if found then
    return;
  end if;

  return query
  select
    'operator'::text,
    token.token_id,
    token.key_id,
    null::uuid,
    null::text
  from murmur.operator_tokens as token
  where token.secret_hash = p_secret_hash
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp());

  if found then
    return;
  end if;

  return query
  update murmur.access_tokens as token
  set last_used_at = pg_catalog.statement_timestamp()
  from murmur.tenants as tenant
  where token.secret_hash = p_secret_hash
    and token.tenant_id = tenant.tenant_id
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
    and tenant.status = 'active'
    and (
      token.last_used_at is null
      or token.last_used_at < pg_catalog.statement_timestamp() - interval '5 minutes'
    )
  returning
    'tenant'::text,
    token.token_id,
    token.key_id,
    token.tenant_id,
    token.token_role;

  if found then
    return;
  end if;

  return query
  select
    'tenant'::text,
    token.token_id,
    token.key_id,
    token.tenant_id,
    token.token_role
  from murmur.access_tokens as token
  join murmur.tenants as tenant on tenant.tenant_id = token.tenant_id
  where token.secret_hash = p_secret_hash
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
    and tenant.status = 'active';
end;
$function$;

create function murmur.active_credential_hints()
returns table(credential_key text, tenant_key text)
language sql
security definer
stable
set search_path = ''
as $function$
  select
    pg_catalog.encode(pg_catalog.sha256(state.expected_secret_hash), 'hex'),
    null::text
  from murmur.bootstrap_state as state
  where state.completed_at is null

  union all

  select
    pg_catalog.encode(pg_catalog.sha256(token.secret_hash), 'hex'),
    null::text
  from murmur.operator_tokens as token
  where token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())

  union all

  select
    pg_catalog.encode(pg_catalog.sha256(token.secret_hash), 'hex'),
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.sha256(pg_catalog.convert_to(token.tenant_id::text, 'UTF8'))
      ),
      'hex'
    )
  from murmur.access_tokens as token
  join murmur.tenants as tenant on tenant.tenant_id = token.tenant_id
  where token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
    and tenant.status = 'active';
$function$;

create function murmur.operator_has_active_token()
returns boolean
language sql
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from murmur.operator_tokens as token
    where token.revoked_at is null
      and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
  );
$function$;

create function murmur.tenant_onboarding_enabled()
returns boolean
language sql
security definer
set search_path = ''
as $function$
  select state.tenant_contract_version >= 2
  from murmur.platform_state as state
  where state.singleton_id = 1;
$function$;

create function murmur.require_operator(p_secret_hash bytea)
returns table(token_id uuid, key_id text)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return query
  update murmur.operator_tokens as token
  set last_used_at = pg_catalog.statement_timestamp()
  where token.secret_hash = p_secret_hash
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
    and (
      token.last_used_at is null
      or token.last_used_at < pg_catalog.statement_timestamp() - interval '5 minutes'
    )
  returning token.token_id, token.key_id;

  if found then
    return;
  end if;

  return query
  select token.token_id, token.key_id
  from murmur.operator_tokens as token
  where token.secret_hash = p_secret_hash
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp());

  if not found then
    raise exception 'operator credential rejected' using errcode = '42501';
  end if;
end;
$function$;

create function murmur.operator_bootstrap(
  p_bootstrap_secret_hash bytea,
  p_token_id uuid,
  p_key_id text,
  p_secret_hash bytea,
  p_token_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claimed integer;
begin
  update murmur.bootstrap_state
  set completed_at = pg_catalog.statement_timestamp(), initial_key_id = p_key_id
  where singleton_id = 1
    and completed_at is null
    and expected_secret_hash = p_bootstrap_secret_hash;
  get diagnostics claimed = row_count;

  if claimed <> 1 then
    raise exception 'operator bootstrap credential rejected or bootstrap already completed'
      using errcode = '42501';
  end if;

  insert into murmur.operator_tokens(token_id, key_id, secret_hash, name)
  values (p_token_id, p_key_id, p_secret_hash, p_token_name);

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id
  ) values (
    p_token_id, p_key_id, 'operator.bootstrap', 'operator_token', p_token_id::text
  );
end;
$function$;

create function murmur.configure_operator_bootstrap(
  p_bootstrap_token_id uuid,
  p_bootstrap_key_id text,
  p_expected_secret_hash bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.octet_length(p_expected_secret_hash) <> 32 then
    raise exception 'bootstrap credential hash must contain 32 bytes' using errcode = '22023';
  end if;

  if exists (
    select 1
    from murmur.bootstrap_state
    where singleton_id = 1 and completed_at is not null
  ) then
    return;
  end if;

  insert into murmur.bootstrap_state(
    singleton_id, bootstrap_token_id, bootstrap_key_id, expected_secret_hash
  )
  values (1, p_bootstrap_token_id, p_bootstrap_key_id, p_expected_secret_hash)
  on conflict (singleton_id) do update
  set bootstrap_token_id = excluded.bootstrap_token_id,
      bootstrap_key_id = excluded.bootstrap_key_id,
      expected_secret_hash = excluded.expected_secret_hash,
      configured_at = pg_catalog.statement_timestamp()
  where murmur.bootstrap_state.completed_at is null;

  if not found then
    raise exception 'operator bootstrap configuration changed concurrently'
      using errcode = '55000';
  end if;
end;
$function$;

create function murmur.configure_runtime_role_password(p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.octet_length(p_password) < 32 then
    raise exception 'runtime database password must contain at least 32 bytes'
      using errcode = '22023';
  end if;
  execute pg_catalog.format('alter role murmur_app password %L', p_password);
  update murmur.platform_state
  set runtime_role_provisioned_at = pg_catalog.statement_timestamp()
  where singleton_id = 1;
end;
$function$;

create function murmur.operator_break_glass_create(
  p_token_id uuid,
  p_key_id text,
  p_secret_hash bytea,
  p_token_name text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10 then
    raise exception 'break-glass reason must contain at least 10 characters'
      using errcode = '22023';
  end if;

  insert into murmur.operator_tokens(token_id, key_id, secret_hash, name)
  values (p_token_id, p_key_id, p_secret_hash, p_token_name);

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id, metadata
  ) values (
    p_token_id,
    p_key_id,
    'operator_token.break_glass',
    'operator_token',
    p_token_id::text,
    pg_catalog.jsonb_build_object('key_id', p_key_id, 'name', p_token_name, 'reason', p_reason)
  );
end;
$function$;

create function murmur.operator_create_operator_token(
  p_operator_secret_hash bytea,
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
begin
  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  insert into murmur.operator_tokens(
    token_id, key_id, secret_hash, name, expires_at
  ) values (
    p_token_id, p_key_id, p_secret_hash, p_token_name, p_expires_at
  );

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id,
    metadata
  ) values (
    actor_token_id,
    actor_key_id,
    'operator_token.create',
    'operator_token',
    p_token_id::text,
    pg_catalog.jsonb_build_object('key_id', p_key_id, 'name', p_token_name)
  );
end;
$function$;

create function murmur.operator_adopt_legacy_founding_token(
  p_operator_secret_hash bytea,
  p_token_id uuid,
  p_key_id text,
  p_legacy_secret_hash bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_token_id uuid;
  actor_key_id text;
  imported_secret_hash bytea;
  imported_at timestamptz;
begin
  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  select state.legacy_secret_hash, state.legacy_imported_at
  into imported_secret_hash, imported_at
  from murmur.platform_state as state
  where state.singleton_id = 1
  for update;

  if imported_at is not null then
    if imported_secret_hash = p_legacy_secret_hash then
      return false;
    end if;
    raise exception 'a different legacy founding token is already adopted'
      using errcode = '55000';
  end if;

  insert into murmur.access_tokens(
    token_id, tenant_id, key_id, secret_hash, token_role, name
  ) values (
    p_token_id,
    '00000000-0000-4000-8000-000000000001'::uuid,
    p_key_id,
    p_legacy_secret_hash,
    'tenant_admin',
    'Migrated founding tenant administrator'
  );

  update murmur.platform_state
  set legacy_token_id = p_token_id,
      legacy_secret_hash = p_legacy_secret_hash,
      legacy_imported_at = pg_catalog.statement_timestamp()
  where singleton_id = 1;

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id, metadata
  ) values (
    actor_token_id,
    actor_key_id,
    'legacy_token.adopt',
    'tenant',
    '00000000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_object('token_id', p_token_id, 'key_id', p_key_id)
  );

  return true;
end;
$function$;

create function murmur.operator_list_operator_tokens(
  p_operator_secret_hash bytea,
  p_cursor uuid,
  p_limit integer
)
returns table(
  token_id uuid,
  key_id text,
  name text,
  created_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_token_id uuid;
  actor_key_id text;
begin
  if p_limit < 1 or p_limit > 501 then
    raise exception 'operator token list limit must be between 1 and 501'
      using errcode = '22023';
  end if;

  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id
  ) values (
    actor_token_id, actor_key_id, 'operator_token.list', 'operator_token', '*'
  );

  return query
  select
    token.token_id,
    token.key_id,
    token.name,
    token.created_at,
    token.expires_at,
    token.revoked_at,
    token.last_used_at
  from murmur.operator_tokens as token
  where p_cursor is null
    or (token.created_at, token.token_id) < (
      select cursor_token.created_at, cursor_token.token_id
      from murmur.operator_tokens as cursor_token
      where cursor_token.token_id = p_cursor
    )
  order by token.created_at desc, token.token_id desc
  limit p_limit;
end;
$function$;

create function murmur.operator_revoke_operator_token(
  p_operator_secret_hash bytea,
  p_key_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_token_id uuid;
  actor_key_id text;
  revoked_token_id uuid;
begin
  lock table murmur.operator_tokens in share row exclusive mode;

  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  if exists (
    select 1
    from murmur.operator_tokens as token
    where token.key_id = p_key_id
      and token.revoked_at is null
      and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
  ) and not exists (
    select 1
    from murmur.operator_tokens as replacement
    where replacement.key_id <> p_key_id
      and replacement.revoked_at is null
      and replacement.expires_at is null
  ) then
    raise exception 'cannot revoke the last active operator token; another non-expiring operator is required'
      using errcode = '23000';
  end if;

  update murmur.operator_tokens as token
  set revoked_at = pg_catalog.statement_timestamp()
  where token.key_id = p_key_id
    and token.revoked_at is null
  returning token.token_id into revoked_token_id;

  if revoked_token_id is not null then
    insert into murmur.admin_audit(
      actor_token_id, actor_key_id, action, target_kind, target_id,
      metadata
    ) values (
      actor_token_id,
      actor_key_id,
      'operator_token.revoke',
      'operator_token',
      revoked_token_id::text,
      pg_catalog.jsonb_build_object('key_id', p_key_id)
    );
  end if;

  return revoked_token_id;
end;
$function$;

create function murmur.operator_create_tenant(
  p_operator_secret_hash bytea,
  p_tenant_id uuid,
  p_slug text,
  p_display_name text,
  p_token_id uuid,
  p_key_id text,
  p_secret_hash bytea,
  p_token_name text
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
  actor_token_id uuid;
  actor_key_id text;
begin
  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  if not murmur.tenant_onboarding_enabled() then
    raise exception 'tenant onboarding is unavailable until the tenant key contract migration completes'
      using errcode = '55000';
  end if;

  insert into murmur.tenants(tenant_id, slug, display_name)
  values (p_tenant_id, p_slug, p_display_name);

  insert into murmur.access_tokens(
    token_id, tenant_id, key_id, secret_hash, token_role, name
  ) values (
    p_token_id, p_tenant_id, p_key_id, p_secret_hash, 'tenant_admin', p_token_name
  );

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id,
    metadata
  ) values (
    actor_token_id,
    actor_key_id,
    'tenant.create',
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

create function murmur.operator_suspend_tenant(
  p_operator_secret_hash bytea,
  p_tenant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_token_id uuid;
  actor_key_id text;
  affected integer;
begin
  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  update murmur.tenants
  set status = 'suspended', suspended_at = pg_catalog.statement_timestamp()
  where tenant_id = p_tenant_id
    and status = 'active';
  get diagnostics affected = row_count;

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id,
    metadata
  ) values (
    actor_token_id,
    actor_key_id,
    'tenant.suspend',
    'tenant',
    p_tenant_id::text,
    pg_catalog.jsonb_build_object('changed', affected = 1)
  );
  return affected = 1;
end;
$function$;

create function murmur.operator_restore_tenant(
  p_operator_secret_hash bytea,
  p_tenant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_token_id uuid;
  actor_key_id text;
  affected integer;
begin
  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  update murmur.tenants
  set status = 'active', suspended_at = null
  where tenant_id = p_tenant_id
    and status = 'suspended';
  get diagnostics affected = row_count;

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id,
    metadata
  ) values (
    actor_token_id,
    actor_key_id,
    'tenant.restore',
    'tenant',
    p_tenant_id::text,
    pg_catalog.jsonb_build_object('changed', affected = 1)
  );
  return affected = 1;
end;
$function$;

create function murmur.operator_mint_tenant_admin_token(
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

  delete from murmur.access_tokens
  where tenant_id = p_tenant_id
    and (
      revoked_at is not null
      or expires_at <= pg_catalog.statement_timestamp()
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

create function murmur.operator_list_tenants(
  p_operator_secret_hash bytea,
  p_cursor uuid,
  p_limit integer
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
  actor_token_id uuid;
  actor_key_id text;
begin
  if p_limit < 1 or p_limit > 501 then
    raise exception 'tenant list limit must be between 1 and 501'
      using errcode = '22023';
  end if;

  select required.token_id, required.key_id
  into strict actor_token_id, actor_key_id
  from murmur.require_operator(p_operator_secret_hash) as required;

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id
  ) values (
    actor_token_id, actor_key_id, 'tenant.list', 'tenant', '*'
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
  where p_cursor is null
    or (tenant.created_at, tenant.tenant_id) > (
      select cursor_tenant.created_at, cursor_tenant.tenant_id
      from murmur.tenants as cursor_tenant
      where cursor_tenant.tenant_id = p_cursor
    )
  order by tenant.created_at, tenant.tenant_id
  limit p_limit;
end;
$function$;

create function murmur.operator_list_admin_audit(
  p_operator_secret_hash bytea,
  p_limit integer
)
returns table(
  audit_id bigint,
  actor_token_id uuid,
  actor_key_id text,
  action text,
  target_kind text,
  target_id text,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_token_id uuid;
  actor_key_id text;
begin
  perform 1 from murmur.require_operator(p_operator_secret_hash);
  if p_limit < 1 or p_limit > 500 then
    raise exception 'audit limit must be between 1 and 500' using errcode = '22023';
  end if;

  return query
  select
    audit.audit_id,
    audit.actor_token_id,
    audit.actor_key_id,
    audit.action,
    audit.target_kind,
    audit.target_id,
    audit.metadata,
    audit.created_at
  from murmur.admin_audit as audit
  order by audit.created_at desc, audit.audit_id desc
  limit p_limit;
end;
$function$;

revoke all on function murmur.authenticate_principal(bytea) from public, anon, authenticated;
revoke all on function murmur.active_credential_hints() from public, anon, authenticated;
revoke all on function murmur.operator_has_active_token() from public, anon, authenticated;
revoke all on function murmur.tenant_onboarding_enabled() from public, anon, authenticated;
revoke all on function murmur.require_operator(bytea) from public, anon, authenticated;
revoke all on function murmur.operator_bootstrap(bytea, uuid, text, bytea, text)
  from public, anon, authenticated;
revoke all on function murmur.configure_operator_bootstrap(uuid, text, bytea)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.configure_runtime_role_password(text)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.operator_break_glass_create(uuid, text, bytea, text, text)
  from public, anon, authenticated, murmur_app;
revoke all on function murmur.operator_create_operator_token(
  bytea, uuid, text, bytea, text, timestamptz
) from public, anon, authenticated;
revoke all on function murmur.operator_adopt_legacy_founding_token(bytea, uuid, text, bytea)
  from public, anon, authenticated;
revoke all on function murmur.operator_list_operator_tokens(bytea, uuid, integer)
  from public, anon, authenticated;
revoke all on function murmur.operator_revoke_operator_token(bytea, text)
  from public, anon, authenticated;
revoke all on function murmur.operator_create_tenant(
  bytea, uuid, text, text, uuid, text, bytea, text
) from public, anon, authenticated;
revoke all on function murmur.operator_suspend_tenant(bytea, uuid)
  from public, anon, authenticated;
revoke all on function murmur.operator_restore_tenant(bytea, uuid)
  from public, anon, authenticated;
revoke all on function murmur.operator_mint_tenant_admin_token(
  bytea, uuid, uuid, text, bytea, text, timestamptz
) from public, anon, authenticated;
revoke all on function murmur.operator_list_tenants(bytea, uuid, integer)
  from public, anon, authenticated;
revoke all on function murmur.operator_list_admin_audit(bytea, integer)
  from public, anon, authenticated;

grant execute on function murmur.authenticate_principal(bytea) to murmur_app;
grant execute on function murmur.active_credential_hints() to murmur_app;
grant execute on function murmur.operator_has_active_token() to murmur_app;
grant execute on function murmur.tenant_onboarding_enabled() to murmur_app;
grant execute on function murmur.operator_bootstrap(bytea, uuid, text, bytea, text) to murmur_app;
grant execute on function murmur.operator_create_operator_token(
  bytea, uuid, text, bytea, text, timestamptz
) to murmur_app;
grant execute on function murmur.operator_adopt_legacy_founding_token(bytea, uuid, text, bytea)
  to murmur_app;
grant execute on function murmur.operator_list_operator_tokens(bytea, uuid, integer) to murmur_app;
grant execute on function murmur.operator_revoke_operator_token(bytea, text) to murmur_app;
grant execute on function murmur.operator_create_tenant(
  bytea, uuid, text, text, uuid, text, bytea, text
) to murmur_app;
grant execute on function murmur.operator_suspend_tenant(bytea, uuid) to murmur_app;
grant execute on function murmur.operator_restore_tenant(bytea, uuid) to murmur_app;
grant execute on function murmur.operator_mint_tenant_admin_token(
  bytea, uuid, uuid, text, bytea, text, timestamptz
) to murmur_app;
grant execute on function murmur.operator_list_tenants(bytea, uuid, integer) to murmur_app;
grant execute on function murmur.operator_list_admin_audit(bytea, integer) to murmur_app;

commit;
