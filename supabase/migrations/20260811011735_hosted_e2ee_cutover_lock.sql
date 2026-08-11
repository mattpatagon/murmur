begin;

alter table murmur.e2ee_claims
  add column orchestrator_token_id uuid,
  add constraint e2ee_claims_tenant_orchestrator_token_fkey
    foreign key (tenant_id, orchestrator_token_id)
    references murmur.access_tokens(tenant_id, token_id);

-- The runtime role intentionally has no UPDATE privilege on the state table,
-- but PostgreSQL row locks require it. Keep the lock behind a tenant-bound
-- definer function so encrypted writes serialize with administrator cutovers
-- without broadening the runtime table grant.
create function murmur.require_tenant_e2ee_write_state(
  p_tenant_id uuid,
  p_required_state text,
  p_alternate_state text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_state text;
  context_tenant_id uuid;
begin
  context_tenant_id := nullif(
    pg_catalog.current_setting('murmur.tenant_id', true), ''
  )::uuid;
  if context_tenant_id is null or context_tenant_id <> p_tenant_id then
    raise exception 'tenant E2E state context rejected' using errcode = '42501';
  end if;
  if p_required_state not in ('off', 'provisioning', 'enforced')
    or (
      p_alternate_state is not null
      and p_alternate_state not in ('off', 'provisioning', 'enforced')
    )
  then
    raise exception 'tenant E2E write state is invalid' using errcode = '22023';
  end if;

  select state.state into strict current_state
  from murmur.tenant_e2ee_state as state
  where state.tenant_id = p_tenant_id
  for share;

  if current_state <> p_required_state
    and (p_alternate_state is null or current_state <> p_alternate_state)
  then
    raise exception 'tenant E2E state does not allow encrypted writes' using errcode = '55000';
  end if;
  return true;
end;
$function$;

revoke all on function murmur.require_tenant_e2ee_write_state(uuid, text, text)
  from public, anon, authenticated;
grant execute on function murmur.require_tenant_e2ee_write_state(uuid, text, text)
  to murmur_app;

-- Serialize plaintext admission with the tenant cutover row. Without this
-- lock, an insert trigger could observe the pre-cutover state while a
-- concurrent enforcement transaction observed no committed plaintext row.
create or replace function murmur.enforce_plaintext_e2ee_cutover()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  context_tenant_id uuid;
  writes_blocked boolean;
begin
  context_tenant_id := nullif(
    pg_catalog.current_setting('murmur.tenant_id', true), ''
  )::uuid;
  if context_tenant_id is null or context_tenant_id <> new.tenant_id then
    raise exception 'plaintext message tenant context rejected' using errcode = '42501';
  end if;
  select state.plaintext_writes_blocked into strict writes_blocked
  from murmur.tenant_e2ee_state as state
  where state.tenant_id = new.tenant_id
  for share;

  if writes_blocked then
    raise exception 'plaintext message writes are disabled for this tenant' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function murmur.enforce_plaintext_e2ee_cutover()
  from public, anon, authenticated;
grant execute on function murmur.enforce_plaintext_e2ee_cutover() to murmur_app;

create or replace function murmur.tenant_transition_e2ee(
  p_tenant_id uuid,
  p_actor_token_id uuid,
  p_action text,
  p_expected_state text,
  p_trust_policy_version bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_key_id text;
  current_state murmur.tenant_e2ee_state%rowtype;
  next_state text;
  next_blocked boolean;
  next_trust_policy_version bigint;
begin
  select token.key_id into actor_key_id
  from murmur.access_tokens as token
  join murmur.tenants as tenant on tenant.tenant_id = token.tenant_id
  where token.tenant_id = p_tenant_id
    and token.token_id = p_actor_token_id
    and token.token_role = 'tenant_admin'
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
    and tenant.status = 'active'
  for share of token, tenant;
  if actor_key_id is null then
    raise exception 'tenant administrator credential rejected' using errcode = '42501';
  end if;

  select * into strict current_state
  from murmur.tenant_e2ee_state
  where tenant_id = p_tenant_id
  for update;

  if p_action = 'begin_provisioning' then
    if current_state.state = 'provisioning' and not current_state.plaintext_writes_blocked then
      return false;
    end if;
    next_state := 'provisioning';
    next_blocked := false;
    next_trust_policy_version := current_state.trust_policy_version;
  elsif p_action = 'block_plaintext_writes' then
    if current_state.state = 'provisioning' and current_state.plaintext_writes_blocked then
      return false;
    end if;
    next_state := 'provisioning';
    next_blocked := true;
    next_trust_policy_version := current_state.trust_policy_version;
  elsif p_action = 'enforce' then
    if p_trust_policy_version is null or p_trust_policy_version <= 0 then
      raise exception 'E2E enforcement requires a positive trust-policy version'
        using errcode = '22023';
    end if;
    if current_state.state = 'enforced'
      and current_state.trust_policy_version = p_trust_policy_version
    then
      return false;
    end if;
    next_state := 'enforced';
    next_blocked := true;
    next_trust_policy_version := p_trust_policy_version;
  elsif p_action = 'rollback_off' then
    if current_state.state = 'off' then return false; end if;
    next_state := 'off';
    next_blocked := false;
    next_trust_policy_version := current_state.trust_policy_version;
  else
    raise exception 'unknown tenant E2E transition action' using errcode = '22023';
  end if;

  if current_state.state <> p_expected_state then
    raise exception 'tenant E2E state changed before transition' using errcode = '40001';
  end if;

  if (p_action = 'begin_provisioning' and current_state.state <> 'off')
    or (
      p_action = 'block_plaintext_writes'
      and (current_state.state <> 'provisioning' or current_state.plaintext_writes_blocked)
    )
    or (
      p_action = 'enforce'
      and not (
        (current_state.state = 'provisioning' and current_state.plaintext_writes_blocked)
        or current_state.state = 'enforced'
      )
    )
    or (p_action = 'rollback_off' and current_state.state not in ('provisioning', 'enforced'))
  then
    raise exception 'tenant E2E transition is invalid from the current state'
      using errcode = '55000';
  end if;

  update murmur.tenant_e2ee_state
  set state = next_state,
      plaintext_writes_blocked = next_blocked,
      trust_policy_version = next_trust_policy_version
  where tenant_id = p_tenant_id;

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id, metadata
  ) values (
    p_actor_token_id,
    actor_key_id,
    'tenant_e2ee.transition',
    'tenant',
    p_tenant_id::text,
    pg_catalog.jsonb_build_object(
      'action', p_action,
      'from_state', current_state.state,
      'to_state', next_state,
      'plaintext_writes_blocked', next_blocked,
      'trust_policy_version', next_trust_policy_version
    )
  );
  return true;
end;
$function$;

revoke all on function murmur.tenant_transition_e2ee(uuid, uuid, text, text, bigint)
  from public, anon, authenticated;
grant execute on function murmur.tenant_transition_e2ee(uuid, uuid, text, text, bigint)
  to murmur_app;

create or replace function murmur.tenant_reset_e2ee_identity(
  p_tenant_id uuid,
  p_actor_token_id uuid,
  p_agent_id text,
  p_expected_root_key_id text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_key_id text;
  stored_root_key_id text;
begin
  if pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
    or pg_catalog.char_length(p_reason) > 500
  then
    raise exception 'identity reset reason must contain 10 to 500 characters'
      using errcode = '22023';
  end if;

  select token.key_id into actor_key_id
  from murmur.access_tokens as token
  join murmur.tenants as tenant on tenant.tenant_id = token.tenant_id
  where token.tenant_id = p_tenant_id
    and token.token_id = p_actor_token_id
    and token.token_role = 'tenant_admin'
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
    and tenant.status = 'active'
  for share of token, tenant;
  if actor_key_id is null then
    raise exception 'tenant administrator credential rejected' using errcode = '42501';
  end if;

  select bundle.root_key_id into stored_root_key_id
  from murmur.e2ee_key_bundles as bundle
  where bundle.tenant_id = p_tenant_id and bundle.agent_id = p_agent_id
  for update;
  if stored_root_key_id is null then return false; end if;
  if stored_root_key_id <> p_expected_root_key_id then
    raise exception 'expected E2E root does not match current identity' using errcode = '55000';
  end if;

  perform 1
  from murmur.tenant_e2ee_usage as usage
  where usage.tenant_id = p_tenant_id
  for update;

  if exists (
    select 1 from murmur.e2ee_claims as claim
    where claim.tenant_id = p_tenant_id
      and (claim.sender_id = p_agent_id or claim.recipient_id = p_agent_id)
      and claim.consumed_at is null
      and claim.expires_at > pg_catalog.statement_timestamp()
  ) or exists (
    select 1
    from murmur.e2ee_broadcasts as broadcast
    left join murmur.e2ee_broadcast_deliveries as delivery
      on delivery.tenant_id = broadcast.tenant_id
      and delivery.broadcast_id = broadcast.broadcast_id
    where broadcast.tenant_id = p_tenant_id
      and broadcast.state = 'pending'
      and (broadcast.sender_id = p_agent_id or delivery.recipient_id = p_agent_id)
  ) then
    raise exception 'agent E2E identity has active encryption work' using errcode = '55000';
  end if;

  delete from murmur.e2ee_key_bundles
  where tenant_id = p_tenant_id and agent_id = p_agent_id;

  update murmur.tenant_e2ee_usage as usage
  set public_prekey_count = (
      select pg_catalog.count(*) from murmur.e2ee_prekeys as prekey
        where prekey.tenant_id = p_tenant_id
          and prekey.retired_at is null and prekey.claimed_at is null
          and prekey.expires_at > pg_catalog.statement_timestamp()
      ),
      claim_count = (
        select pg_catalog.count(*) from murmur.e2ee_claims as claim
        where claim.tenant_id = p_tenant_id and claim.consumed_at is null
      )
  where usage.tenant_id = p_tenant_id;

  insert into murmur.admin_audit(
    actor_token_id, actor_key_id, action, target_kind, target_id, metadata
  ) values (
    p_actor_token_id,
    actor_key_id,
    'tenant_e2ee_identity.reset',
    'agent',
    p_agent_id,
    pg_catalog.jsonb_build_object('previous_root_key_id', stored_root_key_id, 'reason', p_reason)
  );
  return true;
end;
$function$;

revoke all on function murmur.tenant_reset_e2ee_identity(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function murmur.tenant_reset_e2ee_identity(uuid, uuid, text, text, text)
  to murmur_app;

commit;
