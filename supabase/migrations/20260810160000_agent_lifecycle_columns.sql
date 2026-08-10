begin;

set local lock_timeout = '5s';

alter table murmur.agents
  add column generation integer not null default 1,
  add column closed_at timestamptz,
  add column close_reason text,
  add constraint agents_generation_positive check (generation >= 1) not valid,
  add constraint agents_close_reason_known check (
    close_reason is null or close_reason in (
      'completed', 'workspace_deleted', 'superseded', 'manual', 'dormant'
    )
  ) not valid,
  add constraint agents_closure_consistent check (
    (closed_at is null) = (close_reason is null)
  ) not valid;

alter table murmur.tenant_resource_usage
  add column retained_agent_count bigint not null default 0,
  add constraint tenant_resource_usage_retained_agents_bounded
    check (retained_agent_count between 0 and 10000) not valid;

commit;
