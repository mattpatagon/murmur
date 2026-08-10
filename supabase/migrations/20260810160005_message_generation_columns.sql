begin;

set local lock_timeout = '5s';

alter table murmur.messages
  add column sender_generation integer not null default 1,
  add column recipient_generation integer not null default 1,
  add constraint messages_sender_generation_positive check (sender_generation >= 1) not valid,
  add constraint messages_recipient_generation_positive
    check (recipient_generation >= 1) not valid;

alter table murmur.broadcasts
  add column sender_generation integer not null default 1,
  add constraint broadcasts_sender_generation_positive check (sender_generation >= 1) not valid;

commit;
