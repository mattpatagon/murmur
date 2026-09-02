begin;

set local lock_timeout = '5s';

alter table murmur.broadcasts
  validate constraint broadcasts_client_name_allowed_connector;

commit;
