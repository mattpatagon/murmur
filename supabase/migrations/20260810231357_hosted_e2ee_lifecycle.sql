begin;

create function murmur.initialize_tenant_e2ee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into murmur.tenant_e2ee_state(tenant_id) values (new.tenant_id);
  insert into murmur.tenant_e2ee_usage(tenant_id) values (new.tenant_id);
  return new;
end;
$function$;

revoke all on function murmur.initialize_tenant_e2ee()
  from public, anon, authenticated, murmur_app;

create trigger initialize_tenant_e2ee_after_insert
after insert on murmur.tenants
for each row execute function murmur.initialize_tenant_e2ee();

create function murmur.enforce_plaintext_e2ee_cutover()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if exists (
    select 1 from murmur.tenant_e2ee_state as state
    where state.tenant_id = new.tenant_id and state.plaintext_writes_blocked
  ) then
    raise exception 'plaintext message writes are disabled for this tenant' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function murmur.enforce_plaintext_e2ee_cutover()
  from public, anon, authenticated;
grant execute on function murmur.enforce_plaintext_e2ee_cutover() to murmur_app;

create trigger enforce_plaintext_e2ee_cutover_before_insert
before insert on murmur.messages
for each row execute function murmur.enforce_plaintext_e2ee_cutover();

create function murmur.enforce_tenant_e2ee_state_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  usage murmur.tenant_e2ee_usage%rowtype;
begin
  if new.trust_policy_version is not null
    and old.trust_policy_version is not null
    and new.trust_policy_version < old.trust_policy_version
  then
    raise exception 'tenant E2E trust-policy version cannot decrease' using errcode = '55000';
  end if;

  if old.state = 'off' and new.state not in ('off', 'provisioning') then
    raise exception 'tenant E2E enforcement requires provisioning' using errcode = '55000';
  end if;

  if old.state = 'provisioning' and new.state = 'enforced' and (
    not new.plaintext_writes_blocked
    or new.trust_policy_version is null
    or exists (
      select 1 from murmur.agents as agent
      where agent.tenant_id = new.tenant_id
        and agent.closed_at is null
        and exists (
          select 1 from murmur.agent_sessions as session
          where session.tenant_id = agent.tenant_id
            and session.agent_id = agent.agent_id
            and session.generation = agent.generation
            and session.ended_at is null
            and session.lease_expires_at > pg_catalog.statement_timestamp()
        )
        and not exists (
          select 1 from murmur.e2ee_key_bundles as bundle
          where bundle.tenant_id = agent.tenant_id
            and bundle.agent_id = agent.agent_id
            and bundle.agent_generation = agent.generation
        )
    )
    or exists (
      select 1 from murmur.messages as message
      where message.tenant_id = new.tenant_id and message.read_at is null
    )
  ) then
    raise exception 'tenant E2E enforcement prerequisites are incomplete' using errcode = '55000';
  end if;

  if new.state = 'off' and old.state <> 'off' then
    select * into strict usage
    from murmur.tenant_e2ee_usage
    where tenant_id = new.tenant_id
    for update;
    if usage.retained_message_count <> 0
      or usage.pending_broadcast_count <> 0
      or usage.pending_delivery_count <> 0
      or usage.claim_count <> 0
    then
      raise exception 'tenant E2E rollback is unavailable while ciphertext is retained'
        using errcode = '55000';
    end if;
  end if;

  new.updated_at := pg_catalog.statement_timestamp();
  return new;
end;
$function$;

revoke all on function murmur.enforce_tenant_e2ee_state_transition()
  from public, anon, authenticated, murmur_app;

create trigger enforce_tenant_e2ee_state_before_update
before update on murmur.tenant_e2ee_state
for each row execute function murmur.enforce_tenant_e2ee_state_transition();

create function murmur.notify_e2ee_inbox_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_notify(
    'murmur_inbox_changed',
    pg_catalog.json_build_object(
      'tenant_id', new.tenant_id,
      'agent_id', new.recipient_id,
      'sequence', new.tenant_sequence
    )::text
  );
  return new;
end;
$function$;

revoke all on function murmur.notify_e2ee_inbox_change()
  from public, anon, authenticated;
grant execute on function murmur.notify_e2ee_inbox_change() to murmur_app;

create trigger notify_e2ee_inbox_change_after_insert
after insert on murmur.e2ee_messages
for each row execute function murmur.notify_e2ee_inbox_change();

create function murmur.enforce_e2ee_claim_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.tenant_id <> old.tenant_id
    or new.claim_id <> old.claim_id
    or new.sender_id <> old.sender_id
    or new.sender_generation <> old.sender_generation
    or new.recipient_id <> old.recipient_id
    or new.recipient_generation <> old.recipient_generation
    or new.prekey_id <> old.prekey_id
    or new.request_json <> old.request_json
    or new.claim_json <> old.claim_json
    or new.message_kind <> old.message_kind
    or new.sender_authority <> old.sender_authority
    or new.orchestrator_policy_id is distinct from old.orchestrator_policy_id
    or new.broadcast_id is distinct from old.broadcast_id
    or new.created_at <> old.created_at
    or new.expires_at <> old.expires_at
    or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at)
    or (new.consumed_at is not null and (
      new.consumed_at < old.created_at
      or new.consumed_at > pg_catalog.statement_timestamp() + interval '5 minutes'
    ))
  then
    raise exception 'encrypted claim is immutable' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function murmur.enforce_e2ee_claim_immutable()
  from public, anon, authenticated;
grant execute on function murmur.enforce_e2ee_claim_immutable() to murmur_app;

create trigger enforce_e2ee_claim_immutable_before_update
before update on murmur.e2ee_claims
for each row execute function murmur.enforce_e2ee_claim_immutable();

create function murmur.enforce_e2ee_broadcast_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.tenant_id <> old.tenant_id
    or new.broadcast_id <> old.broadcast_id
    or new.sender_id <> old.sender_id
    or new.sender_generation <> old.sender_generation
    or new.sender_authority <> old.sender_authority
    or new.thread_id <> old.thread_id
    or new.audience_repository_name is distinct from old.audience_repository_name
    or new.audience_machine_name is distinct from old.audience_machine_name
    or new.idempotency_key is distinct from old.idempotency_key
    or new.request_json <> old.request_json
    or new.recipient_count <> old.recipient_count
    or new.created_at <> old.created_at
    or new.expires_at <> old.expires_at
    or (old.state <> 'pending' and (
      new.state <> old.state or new.committed_at is distinct from old.committed_at
    ))
    or (new.state = 'pending' and new.committed_at is not null)
    or (new.state = 'committed' and new.committed_at is null)
    or (new.state = 'cancelled' and new.committed_at is not null)
  then
    raise exception 'encrypted broadcast transition is invalid' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function murmur.enforce_e2ee_broadcast_transition()
  from public, anon, authenticated;
grant execute on function murmur.enforce_e2ee_broadcast_transition() to murmur_app;

create trigger enforce_e2ee_broadcast_transition_before_update
before update on murmur.e2ee_broadcasts
for each row execute function murmur.enforce_e2ee_broadcast_transition();

create function murmur.enforce_e2ee_delivery_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.tenant_id <> old.tenant_id
    or new.broadcast_id <> old.broadcast_id
    or new.recipient_id <> old.recipient_id
    or new.recipient_generation <> old.recipient_generation
    or new.claim_id <> old.claim_id
    or (old.envelope_json is not null and (
      new.envelope_json is distinct from old.envelope_json
      or new.sender_chain_json is distinct from old.sender_chain_json
      or new.ciphertext_bytes is distinct from old.ciphertext_bytes
      or new.accepted_at is distinct from old.accepted_at
    ))
    or not (
      (
        new.envelope_json is null
        and new.sender_chain_json is null
        and new.ciphertext_bytes is null
        and new.accepted_at is null
      )
      or (
        new.envelope_json is not null
        and new.sender_chain_json is not null
        and new.ciphertext_bytes is not null
        and new.accepted_at is not null
      )
    )
  then
    raise exception 'encrypted broadcast delivery transition is invalid' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function murmur.enforce_e2ee_delivery_transition()
  from public, anon, authenticated;
grant execute on function murmur.enforce_e2ee_delivery_transition() to murmur_app;

create trigger enforce_e2ee_delivery_transition_before_update
before update on murmur.e2ee_broadcast_deliveries
for each row execute function murmur.enforce_e2ee_delivery_transition();

create function murmur.tenant_transition_e2ee(
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
    and tenant.status = 'active';
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

commit;
