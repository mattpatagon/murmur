begin;

alter table murmur.messages
  add column repository_name text,
  add constraint messages_repository_name_length check (
    repository_name is null or char_length(repository_name) between 3 and 500
  );

commit;
