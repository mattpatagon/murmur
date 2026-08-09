alter table murmur.agents validate constraint agents_tenant_id_fkey;
alter table murmur.messages validate constraint messages_tenant_id_fkey;
alter table murmur.messages validate constraint messages_tenant_sender_fkey;
alter table murmur.messages validate constraint messages_tenant_recipient_fkey;
alter table murmur.broadcasts validate constraint broadcasts_tenant_id_fkey;
alter table murmur.broadcasts validate constraint broadcasts_tenant_sender_fkey;
