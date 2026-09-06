begin;

set local lock_timeout = '5s';

alter table murmur.feedback_submissions
  validate constraint feedback_submissions_client_known_slug;

commit;
