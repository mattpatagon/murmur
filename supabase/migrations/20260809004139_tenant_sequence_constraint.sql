begin;

alter table murmur.messages
  add constraint messages_tenant_sequence_positive
    check (tenant_sequence is not null and tenant_sequence > 0) not valid;

commit;
