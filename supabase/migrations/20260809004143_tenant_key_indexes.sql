set lock_timeout = '5s';
set statement_timeout = '5min';

drop index if exists murmur.agents_tenant_agent_primary;

create unique index agents_tenant_agent_primary
  on murmur.agents(tenant_id, agent_id);

drop index if exists murmur.messages_tenant_sequence_unique;

create unique index messages_tenant_sequence_unique
  on murmur.messages(tenant_id, tenant_sequence);

drop index if exists murmur.messages_tenant_recipient_tenant_sequence;

create index messages_tenant_recipient_tenant_sequence
  on murmur.messages(tenant_id, recipient_id, tenant_sequence);

drop index if exists murmur.messages_tenant_recipient_tenant_sequence_unread;

create index messages_tenant_recipient_tenant_sequence_unread
  on murmur.messages(tenant_id, recipient_id, tenant_sequence)
  where read_at is null;

drop index if exists murmur.messages_tenant_thread_tenant_sequence;

create index messages_tenant_thread_tenant_sequence
  on murmur.messages(tenant_id, thread_id, tenant_sequence);

reset statement_timeout;
reset lock_timeout;
