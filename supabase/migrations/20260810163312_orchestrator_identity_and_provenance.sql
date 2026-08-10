begin;

alter table murmur.access_tokens
  add column personal_id uuid,
  add column repository_name text,
  add column orchestrator_agent_id text,
  add column created_by_token_id uuid;

update murmur.access_tokens
set personal_id = token_id
where personal_id is null;

alter table murmur.access_tokens
  alter column personal_id set not null,
  drop constraint access_tokens_role_allowed,
  add constraint access_tokens_role_allowed
    check (token_role in ('agent', 'tenant_admin', 'orchestrator')),
  add constraint access_tokens_repository_format check (
    repository_name is null
    or (
      char_length(repository_name) between 3 and 500
      and repository_name ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$'
    )
  ),
  add constraint access_tokens_orchestrator_binding check (
    (token_role = 'orchestrator' and orchestrator_agent_id is not null)
    or (token_role <> 'orchestrator' and orchestrator_agent_id is null)
  ),
  add constraint access_tokens_orchestrator_agent_length check (
    orchestrator_agent_id is null
    or char_length(orchestrator_agent_id) between 1 and 200
  ),
  add constraint access_tokens_tenant_token_unique unique (tenant_id, token_id);

create index access_tokens_tenant_personal
  on murmur.access_tokens(tenant_id, personal_id);

create unique index access_tokens_active_orchestrator_agent
  on murmur.access_tokens(tenant_id, orchestrator_agent_id)
  where token_role = 'orchestrator' and revoked_at is null;

create function murmur.default_access_token_personal_id()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.personal_id is null then
    new.personal_id := new.token_id;
  end if;
  return new;
end;
$function$;

revoke all on function murmur.default_access_token_personal_id()
  from public, anon, authenticated;
grant execute on function murmur.default_access_token_personal_id() to murmur_app;

create trigger default_access_token_personal_id_before_insert
before insert on murmur.access_tokens
for each row
execute function murmur.default_access_token_personal_id();

alter table murmur.agents
  add column authority text not null default 'peer',
  add constraint agents_authority_allowed
    check (authority in ('peer', 'orchestrator')),
  add constraint agents_tenant_sender_authority_unique
    unique (tenant_id, agent_id, authority);

alter table murmur.messages
  add column sender_authority text not null default 'peer',
  add column message_kind text not null default 'message',
  add column orchestrator_policy_id uuid,
  add constraint messages_sender_authority_allowed
    check (sender_authority in ('peer', 'orchestrator')),
  add constraint messages_kind_allowed
    check (message_kind in ('message', 'orchestration_request')),
  add constraint messages_orchestration_consistent check (
    (message_kind = 'message' and orchestrator_policy_id is null)
    or (
      message_kind = 'orchestration_request'
      and orchestrator_policy_id is not null
      and sender_authority = 'peer'
    )
  );

alter table murmur.broadcasts
  add column sender_authority text not null default 'peer',
  add constraint broadcasts_sender_authority_allowed
    check (sender_authority in ('peer', 'orchestrator'));

alter table murmur.messages
  add constraint messages_tenant_sender_authority_fkey
    foreign key (tenant_id, sender_id, sender_authority)
    references murmur.agents(tenant_id, agent_id, authority)
    not valid;

alter table murmur.broadcasts
  add constraint broadcasts_tenant_sender_authority_fkey
    foreign key (tenant_id, sender_id, sender_authority)
    references murmur.agents(tenant_id, agent_id, authority)
    not valid;

alter table murmur.messages
  validate constraint messages_tenant_sender_authority_fkey;

alter table murmur.broadcasts
  validate constraint broadcasts_tenant_sender_authority_fkey;

create function murmur.enforce_agent_authority_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.authority <> old.authority then
    raise exception 'agent authority is immutable' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create function murmur.enforce_message_provenance_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.sender_authority <> old.sender_authority
    or new.message_kind <> old.message_kind
    or new.orchestrator_policy_id is distinct from old.orchestrator_policy_id
  then
    raise exception 'message provenance is immutable' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function murmur.enforce_agent_authority_immutable()
  from public, anon, authenticated;
revoke all on function murmur.enforce_message_provenance_immutable()
  from public, anon, authenticated;
grant execute on function murmur.enforce_agent_authority_immutable() to murmur_app;
grant execute on function murmur.enforce_message_provenance_immutable() to murmur_app;

create trigger enforce_agent_authority_before_update
before update on murmur.agents
for each row
execute function murmur.enforce_agent_authority_immutable();

create trigger enforce_message_provenance_before_update
before update on murmur.messages
for each row
execute function murmur.enforce_message_provenance_immutable();

revoke update on table murmur.messages from murmur_app;
grant update(read_at) on table murmur.messages to murmur_app;
revoke update on table murmur.broadcasts from murmur_app;

commit;
