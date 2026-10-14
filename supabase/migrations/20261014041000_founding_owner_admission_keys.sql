begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- These double hashes identify admission lanes, never authenticate a bearer token.
-- The fixed tenant and LIMIT keep startup independent of the global token directory.
create function murmur.founding_owner_admission_keys()
returns table(admission_key text)
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.encode(pg_catalog.sha256(token.secret_hash), 'hex')
  from murmur.access_tokens as token
  join murmur.tenants as tenant on tenant.tenant_id = token.tenant_id
  where token.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
    and tenant.status = 'active'
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > pg_catalog.statement_timestamp())
  order by token.token_id
  limit 1000
$function$;

revoke all on function murmur.founding_owner_admission_keys() from public, anon, authenticated;
grant execute on function murmur.founding_owner_admission_keys() to murmur_app;

commit;
