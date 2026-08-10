begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

alter table murmur.messages
  validate constraint messages_sender_generation_positive;
alter table murmur.messages
  validate constraint messages_recipient_generation_positive;
alter table murmur.broadcasts
  validate constraint broadcasts_sender_generation_positive;

commit;
