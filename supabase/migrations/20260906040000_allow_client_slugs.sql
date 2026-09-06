begin;

set local lock_timeout = '5s';

alter table murmur.messages
  add constraint messages_client_name_allowed_slug check (
    client_name is null or (client_name collate "C") ~ '^[a-z][a-z0-9-]{0,31}$'
  ) not valid;

alter table murmur.broadcasts
  add constraint broadcasts_client_name_allowed_slug check (
    (client_name collate "C") ~ '^[a-z][a-z0-9-]{0,31}$'
  ) not valid;

alter table murmur.feedback_submissions
  add constraint feedback_submissions_client_known_slug check (
    (client_name collate "C") ~ '^[a-z][a-z0-9-]{0,31}$'
  ) not valid;

commit;
