begin;

create function murmur.tenant_reset_e2ee_identity(
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
    and tenant.status = 'active';
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
