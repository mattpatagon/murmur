set lock_timeout = '5s';
set statement_timeout = '5min';

drop index if exists murmur.agents_tenant_agent_unique;

create unique index agents_tenant_agent_unique
  on murmur.agents(tenant_id, agent_id);
drop index if exists murmur.messages_tenant_message_unique;

create unique index messages_tenant_message_unique
  on murmur.messages(tenant_id, message_id);
drop index if exists murmur.messages_tenant_sender_idempotency;

create unique index messages_tenant_sender_idempotency
  on murmur.messages(tenant_id, sender_id, idempotency_key);
drop index if exists murmur.broadcasts_tenant_broadcast_unique;

create unique index broadcasts_tenant_broadcast_unique
  on murmur.broadcasts(tenant_id, broadcast_id);
drop index if exists murmur.broadcasts_tenant_sender_idempotency;

create unique index broadcasts_tenant_sender_idempotency
  on murmur.broadcasts(tenant_id, sender_id, idempotency_key);

reset statement_timeout;
reset lock_timeout;
