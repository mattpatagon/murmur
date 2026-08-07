begin;

alter table murmur.messages
  add column branch_name text,
  add column client_name text,
  add constraint messages_branch_name_length check (
    branch_name is null or char_length(branch_name) between 1 and 500
  ),
  add constraint messages_client_name_allowed check (
    client_name is null or client_name in ('claude', 'codex')
  );

commit;
