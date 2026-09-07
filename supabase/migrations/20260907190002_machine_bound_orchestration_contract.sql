begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table murmur.orchestrator_policies
  drop constraint orchestrator_policies_scope_unique,
  add constraint orchestrator_policies_scope_unique
    unique using index orchestrator_policies_scope_machine_unique;

drop index murmur.orchestrator_policies_resolution;
alter index murmur.orchestrator_policies_resolution_machine
  rename to orchestrator_policies_resolution;

commit;
