begin;

-- Fresh hybrid installations finalize tenant keys after all migrations. Rebind
-- E2E endpoint references in the same transaction as the compatibility index
-- is replaced by the tenant-qualified primary key.
create or replace function murmur.finalize_tenant_contract()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);

  if exists (
    select 1
    from murmur.platform_state as state
    where state.singleton_id = 1
      and state.tenant_contract_version >= 2
  ) then
    return false;
  end if;

  alter table murmur.agent_sessions
    drop constraint agent_sessions_tenant_agent_fkey;
  alter table murmur.e2ee_key_bundles
    drop constraint e2ee_key_bundles_tenant_id_agent_id_fkey;
  alter table murmur.e2ee_claims
    drop constraint e2ee_claims_tenant_id_recipient_id_fkey;
  alter table murmur.e2ee_messages
    drop constraint e2ee_messages_tenant_id_recipient_id_fkey;
  alter table murmur.e2ee_broadcast_deliveries
    drop constraint e2ee_broadcast_deliveries_tenant_id_recipient_id_fkey;

  alter table murmur.messages
    drop constraint messages_sender_id_fkey,
    drop constraint messages_recipient_id_fkey,
    drop constraint messages_broadcast_id_fkey,
    drop constraint messages_sender_idempotency,
    drop constraint messages_tenant_sender_fkey,
    drop constraint messages_tenant_recipient_fkey;

  alter table murmur.broadcasts
    drop constraint broadcasts_sender_id_fkey,
    drop constraint broadcasts_sender_idempotency,
    drop constraint broadcasts_tenant_sender_fkey;

  alter table murmur.agents drop constraint agents_pkey;
  alter table murmur.agents
    add constraint agents_pkey
    primary key using index agents_tenant_agent_primary;
  alter table murmur.agents drop constraint agents_tenant_agent_unique;

  alter table murmur.agent_sessions
    add constraint agent_sessions_tenant_agent_fkey
      foreign key (tenant_id, agent_id)
      references murmur.agents(tenant_id, agent_id)
      on delete cascade
      not valid;
  alter table murmur.e2ee_key_bundles
    add constraint e2ee_key_bundles_tenant_id_agent_id_fkey
      foreign key (tenant_id, agent_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;
  alter table murmur.e2ee_claims
    add constraint e2ee_claims_tenant_id_recipient_id_fkey
      foreign key (tenant_id, recipient_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;
  alter table murmur.e2ee_messages
    add constraint e2ee_messages_tenant_id_recipient_id_fkey
      foreign key (tenant_id, recipient_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;
  alter table murmur.e2ee_broadcast_deliveries
    add constraint e2ee_broadcast_deliveries_tenant_id_recipient_id_fkey
      foreign key (tenant_id, recipient_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;

  alter table murmur.messages
    add constraint messages_tenant_sender_fkey
      foreign key (tenant_id, sender_id)
      references murmur.agents(tenant_id, agent_id)
      not valid,
    add constraint messages_tenant_recipient_fkey
      foreign key (tenant_id, recipient_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;

  alter table murmur.broadcasts
    add constraint broadcasts_tenant_sender_fkey
      foreign key (tenant_id, sender_id)
      references murmur.agents(tenant_id, agent_id)
      not valid;

  alter table murmur.agents alter column tenant_id drop default;
  alter table murmur.messages alter column tenant_id drop default;
  alter table murmur.broadcasts alter column tenant_id drop default;

  update murmur.platform_state
  set tenant_contract_version = 2
  where singleton_id = 1;

  return true;
end;
$function$;

create or replace function murmur.validate_tenant_contract()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);

  if not exists (
    select 1
    from murmur.platform_state as state
    where state.singleton_id = 1
      and state.tenant_contract_version >= 2
  ) then
    raise exception 'tenant contract must be finalized before validation'
      using errcode = '55000';
  end if;

  alter table murmur.agent_sessions
    validate constraint agent_sessions_tenant_agent_fkey;
  alter table murmur.e2ee_key_bundles
    validate constraint e2ee_key_bundles_tenant_id_agent_id_fkey;
  alter table murmur.e2ee_claims
    validate constraint e2ee_claims_tenant_id_recipient_id_fkey;
  alter table murmur.e2ee_messages
    validate constraint e2ee_messages_tenant_id_recipient_id_fkey;
  alter table murmur.e2ee_broadcast_deliveries
    validate constraint e2ee_broadcast_deliveries_tenant_id_recipient_id_fkey;
  alter table murmur.messages validate constraint messages_tenant_sender_fkey;
  alter table murmur.messages validate constraint messages_tenant_recipient_fkey;
  alter table murmur.broadcasts validate constraint broadcasts_tenant_sender_fkey;
end;
$function$;

commit;
