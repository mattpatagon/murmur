begin;

create table murmur.broadcasts (
  broadcast_id uuid primary key,
  thread_id text not null,
  sender_id text not null references murmur.agents(agent_id),
  content text not null,
  repository_name text not null,
  branch_name text not null,
  client_name text not null,
  audience_repository_name text,
  audience_machine_name text,
  idempotency_key text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  constraint broadcasts_sender_idempotency unique (sender_id, idempotency_key),
  constraint broadcasts_content_length check (char_length(content) between 1 and 100000),
  constraint broadcasts_thread_id_length check (char_length(thread_id) between 1 and 200),
  constraint broadcasts_repository_name_length check (
    char_length(repository_name) between 3 and 500
  ),
  constraint broadcasts_branch_name_length check (char_length(branch_name) between 1 and 500),
  constraint broadcasts_client_name_allowed check (client_name in ('claude', 'codex')),
  constraint broadcasts_audience_repository_name_length check (
    audience_repository_name is null
    or char_length(audience_repository_name) between 3 and 500
  ),
  constraint broadcasts_audience_machine_name_length check (
    audience_machine_name is null
    or char_length(audience_machine_name) between 1 and 200
  ),
  constraint broadcasts_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 200
  ),
  constraint broadcasts_exact_retention check (expires_at = created_at + interval '30 days')
);

create index broadcasts_expiration
  on murmur.broadcasts(expires_at);

alter table murmur.messages
  add column broadcast_id uuid;

alter table murmur.broadcasts enable row level security;

revoke all on table murmur.broadcasts from public;
revoke all on table murmur.broadcasts from anon;
revoke all on table murmur.broadcasts from authenticated;

commit;
