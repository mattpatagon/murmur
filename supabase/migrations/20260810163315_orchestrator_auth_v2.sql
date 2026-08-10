begin;

create function murmur.authenticate_principal_v2(p_secret_hash bytea)
returns table(
  principal_kind text,
  token_id uuid,
  key_id text,
  tenant_id uuid,
  token_role text,
  personal_id uuid,
  repository_name text,
  orchestrator_agent_id text
)
language sql
security definer
volatile
set search_path = ''
as $function$
  select
    authenticated.principal_kind,
    authenticated.token_id,
    authenticated.key_id,
    authenticated.tenant_id,
    authenticated.token_role,
    token.personal_id,
    token.repository_name,
    token.orchestrator_agent_id
  from murmur.authenticate_principal(p_secret_hash) as authenticated
  left join murmur.access_tokens as token
    on authenticated.principal_kind = 'tenant'
    and token.tenant_id = authenticated.tenant_id
    and token.token_id = authenticated.token_id;
$function$;

revoke all on function murmur.authenticate_principal_v2(bytea)
  from public, anon, authenticated;
grant execute on function murmur.authenticate_principal_v2(bytea) to murmur_app;

commit;
