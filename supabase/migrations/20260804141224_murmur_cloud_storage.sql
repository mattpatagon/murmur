begin;

create schema murmur;

revoke all on schema murmur from public;
revoke all on schema murmur from anon;
revoke all on schema murmur from authenticated;

create table murmur.agents (
  agent_id text primary key,
  display_name text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  constraint agents_agent_id_length check (char_length(agent_id) between 1 and 200),
  constraint agents_display_name_length check (char_length(display_name) between 1 and 200)
);

create table murmur.messages (
  sequence bigint generated always as identity primary key,
  message_id uuid not null unique,
  thread_id text not null,
  sender_id text not null references murmur.agents(agent_id),
  recipient_id text not null references murmur.agents(agent_id),
  content text not null,
  idempotency_key text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  read_at timestamptz,
  constraint messages_sender_idempotency unique (sender_id, idempotency_key),
  constraint messages_content_length check (char_length(content) between 1 and 100000),
  constraint messages_thread_id_length check (char_length(thread_id) between 1 and 200),
  constraint messages_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 200
  ),
  constraint messages_exact_retention check (expires_at = created_at + interval '30 days')
);

create index messages_recipient_sequence
  on murmur.messages(recipient_id, sequence);

create index messages_recipient_unread
  on murmur.messages(recipient_id, sequence)
  where read_at is null;

create index messages_thread_sequence
  on murmur.messages(thread_id, sequence);

create index messages_expiration
  on murmur.messages(expires_at);

alter table murmur.agents enable row level security;
alter table murmur.messages enable row level security;

revoke all on table murmur.agents from public;
revoke all on table murmur.agents from anon;
revoke all on table murmur.agents from authenticated;
revoke all on table murmur.messages from public;
revoke all on table murmur.messages from anon;
revoke all on table murmur.messages from authenticated;
revoke all on sequence murmur.messages_sequence_seq from public;
revoke all on sequence murmur.messages_sequence_seq from anon;
revoke all on sequence murmur.messages_sequence_seq from authenticated;

create function murmur.notify_inbox_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_notify(
    'murmur_inbox_changed',
    pg_catalog.json_build_object(
      'agent_id', new.recipient_id,
      'sequence', new.sequence
    )::text
  );
  return new;
end;
$function$;

revoke all on function murmur.notify_inbox_change() from public;
revoke all on function murmur.notify_inbox_change() from anon;
revoke all on function murmur.notify_inbox_change() from authenticated;

create trigger notify_inbox_change_after_insert
after insert on murmur.messages
for each row
execute function murmur.notify_inbox_change();

commit;
