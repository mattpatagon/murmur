begin;

alter table murmur.messages
  add constraint messages_broadcast_id_fkey
  foreign key (broadcast_id)
  references murmur.broadcasts(broadcast_id)
  on delete cascade
  not valid;

commit;

alter table murmur.messages
  validate constraint messages_broadcast_id_fkey;
