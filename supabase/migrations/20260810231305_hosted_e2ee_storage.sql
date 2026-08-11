begin;

create table murmur.tenant_e2ee_state (
  tenant_id uuid primary key references murmur.tenants(tenant_id) on delete cascade,
  state text not null default 'off',
  plaintext_writes_blocked boolean not null default false,
  trust_policy_version bigint,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint tenant_e2ee_state_allowed check (state in ('off', 'provisioning', 'enforced')),
  constraint tenant_e2ee_trust_version_positive
    check (trust_policy_version is null or trust_policy_version > 0),
  constraint tenant_e2ee_state_consistent check (
    (state = 'off' and not plaintext_writes_blocked)
    or state = 'provisioning'
    or (state = 'enforced' and plaintext_writes_blocked and trust_policy_version is not null)
  )
);

create table murmur.tenant_e2ee_usage (
  tenant_id uuid primary key references murmur.tenants(tenant_id) on delete cascade,
  claim_count bigint not null default 0 check (claim_count between 0 and 10000),
  pending_broadcast_count bigint not null default 0
    check (pending_broadcast_count between 0 and 1000),
  pending_ciphertext_bytes bigint not null default 0
    check (pending_ciphertext_bytes between 0 and 67108864),
  pending_delivery_count bigint not null default 0
    check (pending_delivery_count between 0 and 10000),
  public_prekey_count bigint not null default 0
    check (public_prekey_count between 0 and 100000),
  retained_ciphertext_bytes bigint not null default 0
    check (retained_ciphertext_bytes between 0 and 268435456),
  retained_message_count bigint not null default 0
    check (retained_message_count between 0 and 100000)
);

create table murmur.e2ee_key_bundles (
  tenant_id uuid not null,
  agent_id text not null,
  agent_generation bigint not null check (agent_generation > 0),
  root_key_id text not null check (root_key_id ~ '^mrk_[A-Za-z0-9_-]{43}$'),
  agent_key_id text not null check (agent_key_id ~ '^mak_[A-Za-z0-9_-]{43}$'),
  bundle_json jsonb not null check (pg_catalog.octet_length(bundle_json::text) <= 1048576),
  published_at timestamptz not null,
  primary key (tenant_id, agent_id),
  foreign key (tenant_id, agent_id) references murmur.agents(tenant_id, agent_id)
);

create table murmur.e2ee_prekeys (
  tenant_id uuid not null,
  prekey_id text not null check (prekey_id ~ '^mpk_[A-Za-z0-9_-]{43}$'),
  agent_id text not null,
  agent_generation bigint not null check (agent_generation > 0),
  prekey_class text not null check (prekey_class in ('fallback', 'one_time')),
  certificate_json jsonb not null check (pg_catalog.octet_length(certificate_json::text) <= 16384),
  published_at timestamptz not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  retired_at timestamptz,
  primary key (tenant_id, prekey_id),
  foreign key (tenant_id, agent_id)
    references murmur.e2ee_key_bundles(tenant_id, agent_id) on delete cascade
);

create table murmur.e2ee_broadcasts (
  tenant_id uuid not null,
  broadcast_id uuid not null,
  sender_id text not null,
  sender_generation bigint not null check (sender_generation > 0),
  sender_authority text not null check (sender_authority in ('peer', 'orchestrator')),
  thread_id text not null check (char_length(thread_id) between 1 and 200),
  audience_repository_name text,
  audience_machine_name text,
  idempotency_key text,
  request_json jsonb not null check (pg_catalog.octet_length(request_json::text) <= 8192),
  recipient_count integer not null check (recipient_count between 0 and 100),
  state text not null check (state in ('pending', 'committed', 'cancelled')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  committed_at timestamptz,
  primary key (tenant_id, broadcast_id),
  foreign key (tenant_id, sender_id, sender_authority)
    references murmur.agents(tenant_id, agent_id, authority),
  constraint e2ee_broadcast_sender_idempotency unique (tenant_id, sender_id, idempotency_key),
  constraint e2ee_broadcast_audience_repository check (
    audience_repository_name is null or char_length(audience_repository_name) between 3 and 500
  ),
  constraint e2ee_broadcast_audience_machine check (
    audience_machine_name is null or char_length(audience_machine_name) between 1 and 200
  ),
  constraint e2ee_broadcast_idempotency_length check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 200
  )
);

create table murmur.e2ee_claims (
  tenant_id uuid not null,
  claim_id uuid not null,
  sender_id text not null,
  sender_generation bigint not null check (sender_generation > 0),
  recipient_id text not null,
  recipient_generation bigint not null check (recipient_generation > 0),
  prekey_id text not null,
  message_kind text not null check (message_kind in ('message', 'orchestration_request')),
  sender_authority text not null check (sender_authority in ('peer', 'orchestrator')),
  orchestrator_policy_id uuid,
  request_json jsonb not null check (pg_catalog.octet_length(request_json::text) <= 8192),
  claim_json jsonb not null check (pg_catalog.octet_length(claim_json::text) <= 1048576),
  broadcast_id uuid,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  primary key (tenant_id, claim_id),
  foreign key (tenant_id, sender_id, sender_authority)
    references murmur.agents(tenant_id, agent_id, authority),
  foreign key (tenant_id, recipient_id) references murmur.agents(tenant_id, agent_id),
  foreign key (tenant_id, prekey_id)
    references murmur.e2ee_prekeys(tenant_id, prekey_id) on delete cascade,
  foreign key (tenant_id, broadcast_id)
    references murmur.e2ee_broadcasts(tenant_id, broadcast_id) on delete cascade,
  foreign key (tenant_id, orchestrator_policy_id)
    references murmur.orchestrator_policies(tenant_id, policy_id),
  constraint e2ee_claim_provenance_consistent check (
    (message_kind = 'message' and orchestrator_policy_id is null)
    or (
      message_kind = 'orchestration_request'
      and sender_authority = 'peer'
      and orchestrator_policy_id is not null
    )
  )
);

create table murmur.e2ee_messages (
  tenant_id uuid not null,
  tenant_sequence bigint not null check (tenant_sequence > 0),
  message_id uuid not null,
  thread_id text not null check (char_length(thread_id) between 1 and 200),
  sender_id text not null,
  sender_generation bigint not null check (sender_generation > 0),
  sender_authority text not null check (sender_authority in ('peer', 'orchestrator')),
  message_kind text not null check (message_kind in ('message', 'orchestration_request')),
  orchestrator_policy_id uuid,
  recipient_id text not null,
  recipient_generation bigint not null check (recipient_generation > 0),
  broadcast_id uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  pair_counter bigint not null check (pair_counter > 0),
  envelope_json jsonb not null check (pg_catalog.octet_length(envelope_json::text) <= 1048576),
  sender_chain_json jsonb not null check (pg_catalog.octet_length(sender_chain_json::text) <= 1048576),
  ciphertext_bytes integer not null check (ciphertext_bytes between 17 and 524304),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  read_at timestamptz,
  primary key (tenant_id, message_id),
  unique (tenant_id, tenant_sequence),
  unique (tenant_id, sender_id, idempotency_key),
  unique (tenant_id, sender_id, recipient_id, pair_counter),
  foreign key (tenant_id, sender_id, sender_authority)
    references murmur.agents(tenant_id, agent_id, authority),
  foreign key (tenant_id, recipient_id) references murmur.agents(tenant_id, agent_id),
  foreign key (tenant_id, orchestrator_policy_id)
    references murmur.orchestrator_policies(tenant_id, policy_id),
  foreign key (tenant_id, broadcast_id)
    references murmur.e2ee_broadcasts(tenant_id, broadcast_id) on delete cascade,
  constraint e2ee_message_provenance_consistent check (
    (message_kind = 'message' and orchestrator_policy_id is null)
    or (
      message_kind = 'orchestration_request'
      and sender_authority = 'peer'
      and orchestrator_policy_id is not null
    )
  )
);

create table murmur.e2ee_broadcast_deliveries (
  tenant_id uuid not null,
  broadcast_id uuid not null,
  recipient_id text not null,
  recipient_generation bigint not null check (recipient_generation > 0),
  claim_id uuid not null,
  envelope_json jsonb check (pg_catalog.octet_length(envelope_json::text) <= 1048576),
  sender_chain_json jsonb check (pg_catalog.octet_length(sender_chain_json::text) <= 1048576),
  ciphertext_bytes integer check (ciphertext_bytes between 17 and 524304),
  accepted_at timestamptz,
  primary key (tenant_id, broadcast_id, recipient_id),
  unique (tenant_id, claim_id),
  foreign key (tenant_id, broadcast_id)
    references murmur.e2ee_broadcasts(tenant_id, broadcast_id) on delete cascade,
  foreign key (tenant_id, claim_id)
    references murmur.e2ee_claims(tenant_id, claim_id) on delete cascade,
  foreign key (tenant_id, recipient_id) references murmur.agents(tenant_id, agent_id)
);

insert into murmur.tenant_e2ee_state(tenant_id)
select tenant_id from murmur.tenants;

insert into murmur.tenant_e2ee_usage(tenant_id)
select tenant_id from murmur.tenants;

commit;
