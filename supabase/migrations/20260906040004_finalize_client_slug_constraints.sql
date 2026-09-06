begin;

set local lock_timeout = '5s';

alter table murmur.messages
  drop constraint messages_client_name_allowed;
alter table murmur.messages
  rename constraint messages_client_name_allowed_slug to messages_client_name_allowed;

alter table murmur.broadcasts
  drop constraint broadcasts_client_name_allowed;
alter table murmur.broadcasts
  rename constraint broadcasts_client_name_allowed_slug to broadcasts_client_name_allowed;

alter table murmur.feedback_submissions
  drop constraint feedback_submissions_client_known;
alter table murmur.feedback_submissions
  rename constraint feedback_submissions_client_known_slug
    to feedback_submissions_client_known;

commit;
