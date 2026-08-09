begin;

alter table murmur.agents
  add constraint agents_tenant_agent_unique
    unique using index agents_tenant_agent_unique,
  add constraint agents_tenant_id_fkey
    foreign key (tenant_id) references murmur.tenants(tenant_id) not valid;

alter table murmur.messages
  add constraint messages_tenant_message_unique
    unique using index messages_tenant_message_unique,
  add constraint messages_tenant_sender_idempotency
    unique using index messages_tenant_sender_idempotency,
  add constraint messages_tenant_id_fkey
    foreign key (tenant_id) references murmur.tenants(tenant_id) not valid,
  add constraint messages_tenant_sender_fkey
    foreign key (tenant_id, sender_id)
    references murmur.agents(tenant_id, agent_id)
    not valid,
  add constraint messages_tenant_recipient_fkey
    foreign key (tenant_id, recipient_id)
    references murmur.agents(tenant_id, agent_id)
    not valid;

alter table murmur.broadcasts
  add constraint broadcasts_tenant_broadcast_unique
    unique using index broadcasts_tenant_broadcast_unique,
  add constraint broadcasts_tenant_sender_idempotency
    unique using index broadcasts_tenant_sender_idempotency,
  add constraint broadcasts_tenant_id_fkey
    foreign key (tenant_id) references murmur.tenants(tenant_id) not valid,
  add constraint broadcasts_tenant_sender_fkey
    foreign key (tenant_id, sender_id)
    references murmur.agents(tenant_id, agent_id)
    not valid;

commit;

