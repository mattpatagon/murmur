begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

alter table murmur.agents validate constraint agents_generation_positive;
alter table murmur.agents validate constraint agents_close_reason_known;
alter table murmur.agents validate constraint agents_closure_consistent;
alter table murmur.tenant_resource_usage
  validate constraint tenant_resource_usage_retained_agents_bounded;

commit;
