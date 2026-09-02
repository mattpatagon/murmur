begin;

set local lock_timeout = '5s';

alter table murmur.messages
  validate constraint messages_client_name_allowed_connector;

commit;
