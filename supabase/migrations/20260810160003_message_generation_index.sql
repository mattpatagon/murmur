set lock_timeout = '5s';

create index concurrently messages_recipient_generation_sequence
  on murmur.messages(tenant_id, recipient_id, recipient_generation, tenant_sequence);

reset lock_timeout;
