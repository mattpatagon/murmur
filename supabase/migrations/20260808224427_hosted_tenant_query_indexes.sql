set lock_timeout = '5s';
set statement_timeout = '5min';

drop index if exists murmur.agents_tenant_activity;

create index agents_tenant_activity
  on murmur.agents(tenant_id, last_seen_at desc, agent_id);

drop index if exists murmur.agents_tenant_repository_activity;

create index agents_tenant_repository_activity
  on murmur.agents(tenant_id, (metadata ->> 'repository'), last_seen_at);

drop index if exists murmur.agents_tenant_machine_activity;

create index agents_tenant_machine_activity
  on murmur.agents(tenant_id, (metadata ->> 'machine'), last_seen_at);

drop index if exists murmur.messages_tenant_recipient_sequence;

create index messages_tenant_recipient_sequence
  on murmur.messages(tenant_id, recipient_id, sequence);

drop index if exists murmur.messages_tenant_recipient_unread;

create index messages_tenant_recipient_unread
  on murmur.messages(tenant_id, recipient_id, sequence)
  where read_at is null;

drop index if exists murmur.messages_tenant_thread_sequence;

create index messages_tenant_thread_sequence
  on murmur.messages(tenant_id, thread_id, sequence);

drop index if exists murmur.messages_tenant_broadcast_recipient;

create index messages_tenant_broadcast_recipient
  on murmur.messages(tenant_id, broadcast_id, recipient_id)
  where broadcast_id is not null;

drop index if exists murmur.messages_tenant_expiration;

create index messages_tenant_expiration
  on murmur.messages(tenant_id, expires_at);

drop index if exists murmur.broadcasts_tenant_expiration;

create index broadcasts_tenant_expiration
  on murmur.broadcasts(tenant_id, expires_at);

reset statement_timeout;
reset lock_timeout;
