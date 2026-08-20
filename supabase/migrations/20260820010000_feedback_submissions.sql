begin;

set local lock_timeout = '5s';

alter table murmur.tenant_resource_usage
  add column feedback_submission_count bigint not null default 0,
  add column feedback_content_bytes bigint not null default 0,
  add constraint tenant_resource_usage_feedback_submissions_bounded
    check (feedback_submission_count between 0 and 10000),
  add constraint tenant_resource_usage_feedback_content_bounded
    check (feedback_content_bytes between 0 and 67108864);

create table murmur.feedback_submissions (
  tenant_id uuid not null references murmur.tenants(tenant_id),
  feedback_id uuid not null,
  submission_type text not null,
  reporter_id text not null,
  reporter_generation integer not null,
  repository_name text not null,
  branch_name text not null,
  client_name text not null,
  title text not null,
  description text not null,
  idempotency_key text,
  created_at timestamptz not null,
  primary key (tenant_id, feedback_id),
  unique (tenant_id, reporter_id, idempotency_key),
  constraint feedback_submissions_type_known check (
    submission_type in ('issue', 'feature_request')
  ),
  constraint feedback_submissions_reporter_id_format check (
    char_length(reporter_id) between 1 and 200
    and reporter_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint feedback_submissions_reporter_generation_positive check (
    reporter_generation >= 1
  ),
  constraint feedback_submissions_repository_format check (
    char_length(repository_name) between 3 and 500
    and repository_name ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$'
  ),
  constraint feedback_submissions_branch_length check (
    char_length(branch_name) between 1 and 500
  ),
  constraint feedback_submissions_client_known check (
    client_name in ('claude', 'codex')
  ),
  constraint feedback_submissions_title_length check (
    char_length(title) between 1 and 200
  ),
  constraint feedback_submissions_description_length check (
    char_length(description) between 1 and 100000
  ),
  constraint feedback_submissions_idempotency_length check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 200
  )
);

create index feedback_submissions_created
  on murmur.feedback_submissions(tenant_id, created_at desc, feedback_id);

create index feedback_submissions_type_created
  on murmur.feedback_submissions(
    tenant_id,
    submission_type,
    created_at desc,
    feedback_id
  );

create index feedback_submissions_reporter
  on murmur.feedback_submissions(tenant_id, reporter_id);

alter table murmur.feedback_submissions enable row level security;
alter table murmur.feedback_submissions force row level security;

revoke all on table murmur.feedback_submissions from public, anon, authenticated;
grant select, insert on table murmur.feedback_submissions to murmur_app;

create policy feedback_submissions_select_current_tenant
on murmur.feedback_submissions
for select
to murmur_app
using (
  tenant_id = nullif(
    (select pg_catalog.current_setting('murmur.tenant_id', true)),
    ''
  )::uuid
);

create policy feedback_submissions_insert_current_tenant
on murmur.feedback_submissions
for insert
to murmur_app
with check (
  tenant_id = nullif(
    (select pg_catalog.current_setting('murmur.tenant_id', true)),
    ''
  )::uuid
);

create function murmur.enforce_tenant_feedback_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  content_bytes bigint;
begin
  if tg_op = 'INSERT' then
    content_bytes := pg_catalog.octet_length(new.title) + pg_catalog.octet_length(new.description);
    update murmur.tenant_resource_usage as usage
    set
      feedback_submission_count = usage.feedback_submission_count + 1,
      feedback_content_bytes = usage.feedback_content_bytes + content_bytes
    where usage.tenant_id = new.tenant_id
      and usage.feedback_submission_count < 10000
      and usage.feedback_content_bytes + content_bytes <= 67108864;
    if not found then
      raise exception 'tenant retained-feedback quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  content_bytes := pg_catalog.octet_length(old.title) + pg_catalog.octet_length(old.description);
  update murmur.tenant_resource_usage as usage
  set
    feedback_submission_count = usage.feedback_submission_count - 1,
    feedback_content_bytes = usage.feedback_content_bytes - content_bytes
  where usage.tenant_id = old.tenant_id
    and usage.feedback_submission_count > 0
    and usage.feedback_content_bytes >= content_bytes;
  if not found then
    raise exception 'tenant feedback quota accounting inconsistent' using errcode = 'XX001';
  end if;
  return old;
end;
$function$;

revoke all on function murmur.enforce_tenant_feedback_quota()
  from public, anon, authenticated;
grant execute on function murmur.enforce_tenant_feedback_quota() to murmur_app;

create trigger enforce_tenant_feedback_quota_insert
after insert on murmur.feedback_submissions
for each row
execute function murmur.enforce_tenant_feedback_quota();

create trigger release_tenant_feedback_quota_delete
after delete on murmur.feedback_submissions
for each row
execute function murmur.enforce_tenant_feedback_quota();

commit;
