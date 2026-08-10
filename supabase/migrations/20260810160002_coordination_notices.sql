begin;

set local lock_timeout = '5s';

alter table murmur.tenant_resource_usage
  add column notice_count bigint not null default 0,
  add column notice_content_bytes bigint not null default 0,
  add constraint tenant_resource_usage_notices_bounded
    check (notice_count between 0 and 10000),
  add constraint tenant_resource_usage_notice_content_bounded
    check (notice_content_bytes between 0 and 67108864);

create table murmur.notices (
  tenant_id uuid not null references murmur.tenants(tenant_id),
  notice_id uuid not null,
  kind text not null,
  creator_id text not null,
  creator_generation integer not null,
  repository_name text not null,
  branch_name text,
  content text not null,
  idempotency_key text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  resolved_by_id text,
  resolved_by_generation integer,
  resolved_at timestamptz,
  withdrawn_by_id text,
  withdrawn_by_generation integer,
  withdrawn_at timestamptz,
  resolution_note text,
  primary key (tenant_id, notice_id),
  unique (tenant_id, creator_id, idempotency_key),
  constraint notices_kind_known check (
    kind in ('handoff', 'ownership', 'blocker', 'decision')
  ),
  constraint notices_creator_id_format check (
    char_length(creator_id) between 1 and 200
    and creator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint notices_creator_generation_positive check (creator_generation >= 1),
  constraint notices_repository_length check (char_length(repository_name) between 3 and 500),
  constraint notices_branch_length check (
    branch_name is null or char_length(branch_name) between 1 and 500
  ),
  constraint notices_content_length check (char_length(content) between 1 and 100000),
  constraint notices_idempotency_length check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 200
  ),
  constraint notices_expiry_bounds check (
    expires_at >= created_at + interval '1 hour'
    and expires_at <= created_at + interval '90 days'
  ),
  constraint notices_resolution_consistent check (
    (resolved_at is null) = (resolved_by_id is null)
    and (resolved_at is null) = (resolved_by_generation is null)
  ),
  constraint notices_withdrawal_consistent check (
    (withdrawn_at is null) = (withdrawn_by_id is null)
    and (withdrawn_at is null) = (withdrawn_by_generation is null)
  ),
  constraint notices_single_terminal_state check (
    not (resolved_at is not null and withdrawn_at is not null)
  ),
  constraint notices_actor_generation_positive check (
    (resolved_by_generation is null or resolved_by_generation >= 1)
    and (withdrawn_by_generation is null or withdrawn_by_generation >= 1)
  ),
  constraint notices_actor_id_format check (
    (resolved_by_id is null or (
      char_length(resolved_by_id) between 1 and 200
      and resolved_by_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
    and (withdrawn_by_id is null or (
      char_length(withdrawn_by_id) between 1 and 200
      and withdrawn_by_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
  ),
  constraint notices_resolution_note_length check (
    resolution_note is null or char_length(resolution_note) between 1 and 2000
  )
);

create index notices_repository_open
  on murmur.notices(tenant_id, repository_name, created_at desc, notice_id)
  where resolved_at is null and withdrawn_at is null;

create index notices_terminal_cleanup
  on murmur.notices(tenant_id, expires_at, resolved_at, withdrawn_at, notice_id);

alter table murmur.notices enable row level security;
alter table murmur.notices force row level security;

revoke all on table murmur.notices from public, anon, authenticated;
grant select, insert, update, delete on table murmur.notices to murmur_app;

create policy notices_current_tenant
on murmur.notices
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

create function murmur.enforce_tenant_notice_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  content_bytes bigint;
begin
  if tg_op = 'INSERT' then
    content_bytes := pg_catalog.octet_length(new.content);
    update murmur.tenant_resource_usage as usage
    set
      notice_count = usage.notice_count + 1,
      notice_content_bytes = usage.notice_content_bytes + content_bytes
    where usage.tenant_id = new.tenant_id
      and usage.notice_count < 10000
      and usage.notice_content_bytes + content_bytes <= 67108864;
    if not found then
      raise exception 'tenant retained-notice quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  content_bytes := pg_catalog.octet_length(old.content);
  update murmur.tenant_resource_usage as usage
  set
    notice_count = usage.notice_count - 1,
    notice_content_bytes = usage.notice_content_bytes - content_bytes
  where usage.tenant_id = old.tenant_id
    and usage.notice_count > 0
    and usage.notice_content_bytes >= content_bytes;
  if not found then
    raise exception 'tenant notice quota accounting inconsistent' using errcode = 'XX001';
  end if;
  return old;
end;
$function$;

revoke all on function murmur.enforce_tenant_notice_quota()
  from public, anon, authenticated;
grant execute on function murmur.enforce_tenant_notice_quota() to murmur_app;

create trigger enforce_tenant_notice_quota_insert
after insert on murmur.notices
for each row
execute function murmur.enforce_tenant_notice_quota();

create trigger release_tenant_notice_quota_delete
after delete on murmur.notices
for each row
execute function murmur.enforce_tenant_notice_quota();

commit;
