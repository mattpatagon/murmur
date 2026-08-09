begin;

create table murmur.platform_state (
  singleton_id integer primary key default 1,
  tenant_contract_version integer not null default 1,
  legacy_token_id uuid,
  legacy_secret_hash bytea,
  legacy_imported_at timestamptz,
  runtime_role_provisioned_at timestamptz,
  constraint platform_state_singleton check (singleton_id = 1),
  constraint platform_state_tenant_contract_positive check (tenant_contract_version >= 1),
  constraint platform_state_legacy_hash_length check (
    legacy_secret_hash is null or octet_length(legacy_secret_hash) = 32
  ),
  constraint platform_state_legacy_import_consistent check (
    (legacy_token_id is null and legacy_secret_hash is null and legacy_imported_at is null)
    or (legacy_token_id is not null and legacy_secret_hash is not null and legacy_imported_at is not null)
  )
);

insert into murmur.platform_state(singleton_id) values (1);

create table murmur.tenants (
  tenant_id uuid primary key,
  slug text not null unique,
  display_name text not null,
  status text not null default 'active',
  created_at timestamptz not null default statement_timestamp(),
  suspended_at timestamptz,
  constraint tenants_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  constraint tenants_display_name_length check (char_length(display_name) between 1 and 200),
  constraint tenants_status_allowed check (status in ('active', 'suspended')),
  constraint tenants_suspension_consistent check (
    (status = 'active' and suspended_at is null)
    or (status = 'suspended' and suspended_at is not null)
  )
);

insert into murmur.tenants(tenant_id, slug, display_name)
values ('00000000-0000-4000-8000-000000000001', 'founding', 'Founding tenant');

create table murmur.access_tokens (
  token_id uuid primary key,
  tenant_id uuid not null references murmur.tenants(tenant_id),
  key_id text not null unique,
  secret_hash bytea not null unique,
  token_role text not null,
  name text not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint access_tokens_key_id_format check (key_id ~ '^[A-Za-z0-9_-]{8,32}$'),
  constraint access_tokens_hash_length check (octet_length(secret_hash) = 32),
  constraint access_tokens_role_allowed check (token_role in ('agent', 'tenant_admin')),
  constraint access_tokens_name_length check (char_length(name) between 1 and 200),
  constraint access_tokens_expiry_after_creation check (
    expires_at is null or expires_at > created_at
  ),
  constraint access_tokens_revocation_after_creation check (
    revoked_at is null or revoked_at >= created_at
  )
);

create table murmur.operator_tokens (
  token_id uuid primary key,
  key_id text not null unique,
  secret_hash bytea not null unique,
  name text not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint operator_tokens_key_id_format check (key_id ~ '^[A-Za-z0-9_-]{8,32}$'),
  constraint operator_tokens_hash_length check (octet_length(secret_hash) = 32),
  constraint operator_tokens_name_length check (char_length(name) between 1 and 200),
  constraint operator_tokens_expiry_after_creation check (
    expires_at is null or expires_at > created_at
  ),
  constraint operator_tokens_revocation_after_creation check (
    revoked_at is null or revoked_at >= created_at
  )
);

create table murmur.bootstrap_state (
  singleton_id integer primary key default 1,
  bootstrap_token_id uuid not null unique,
  bootstrap_key_id text not null unique,
  expected_secret_hash bytea not null unique,
  configured_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  initial_key_id text,
  constraint bootstrap_state_singleton check (singleton_id = 1),
  constraint bootstrap_state_key_id_format check (bootstrap_key_id ~ '^[A-Za-z0-9_-]{8,32}$'),
  constraint bootstrap_state_hash_length check (octet_length(expected_secret_hash) = 32),
  constraint bootstrap_state_completion_consistent check (
    (completed_at is null and initial_key_id is null)
    or (completed_at is not null and initial_key_id is not null)
  )
);

create table murmur.admin_audit (
  audit_id bigint generated always as identity primary key,
  actor_token_id uuid not null,
  actor_key_id text not null,
  action text not null,
  target_kind text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint admin_audit_action_length check (char_length(action) between 1 and 100),
  constraint admin_audit_target_kind_length check (char_length(target_kind) between 1 and 100),
  constraint admin_audit_target_id_length check (char_length(target_id) between 1 and 500)
);

alter table murmur.agents
  add column tenant_id uuid not null
    default '00000000-0000-4000-8000-000000000001';

alter table murmur.messages
  add column tenant_id uuid not null
    default '00000000-0000-4000-8000-000000000001';

alter table murmur.broadcasts
  add column tenant_id uuid not null
    default '00000000-0000-4000-8000-000000000001';

do $block$
begin
  if (select pg_catalog.count(*) from murmur.agents) > 1000 then
    raise exception 'founding tenant exceeds the 1000-agent migration limit'
      using errcode = '54000';
  end if;
  if (select pg_catalog.count(*) from murmur.messages) > 100000 then
    raise exception 'founding tenant exceeds the 100000-message migration limit'
      using errcode = '54000';
  end if;
  if (
    select coalesce(pg_catalog.sum(pg_catalog.octet_length(content)), 0::bigint)
    from murmur.messages
  ) > 268435456 then
    raise exception 'founding tenant exceeds the 256 MiB message migration limit'
      using errcode = '54000';
  end if;
  if (select pg_catalog.count(*) from murmur.broadcasts) > 10000 then
    raise exception 'founding tenant exceeds the 10000-broadcast migration limit'
      using errcode = '54000';
  end if;
  if (
    select coalesce(pg_catalog.sum(pg_catalog.octet_length(content)), 0::bigint)
    from murmur.broadcasts
  ) > 67108864 then
    raise exception 'founding tenant exceeds the 64 MiB broadcast migration limit'
      using errcode = '54000';
  end if;
end;
$block$;

commit;
