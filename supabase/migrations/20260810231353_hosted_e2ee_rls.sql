begin;

create index e2ee_prekeys_available
  on murmur.e2ee_prekeys(tenant_id, agent_id, prekey_class, retired_at, claimed_at, prekey_id);
create index e2ee_prekeys_expiration on murmur.e2ee_prekeys(tenant_id, expires_at);
create index e2ee_claims_expiration on murmur.e2ee_claims(tenant_id, expires_at);
create index e2ee_claims_broadcast on murmur.e2ee_claims(tenant_id, broadcast_id, recipient_id);
create index e2ee_messages_recipient_sequence
  on murmur.e2ee_messages(tenant_id, recipient_id, tenant_sequence);
create index e2ee_messages_recipient_unread
  on murmur.e2ee_messages(tenant_id, recipient_id, tenant_sequence) where read_at is null;
create index e2ee_messages_thread_sequence
  on murmur.e2ee_messages(tenant_id, thread_id, tenant_sequence);
create index e2ee_messages_expiration on murmur.e2ee_messages(tenant_id, expires_at);
create index e2ee_broadcasts_expiration on murmur.e2ee_broadcasts(tenant_id, expires_at, state);
create index e2ee_deliveries_claim
  on murmur.e2ee_broadcast_deliveries(tenant_id, broadcast_id, claim_id);

alter table murmur.tenant_e2ee_state enable row level security;
alter table murmur.tenant_e2ee_state force row level security;
alter table murmur.tenant_e2ee_usage enable row level security;
alter table murmur.tenant_e2ee_usage force row level security;
alter table murmur.e2ee_key_bundles enable row level security;
alter table murmur.e2ee_key_bundles force row level security;
alter table murmur.e2ee_prekeys enable row level security;
alter table murmur.e2ee_prekeys force row level security;
alter table murmur.e2ee_claims enable row level security;
alter table murmur.e2ee_claims force row level security;
alter table murmur.e2ee_messages enable row level security;
alter table murmur.e2ee_messages force row level security;
alter table murmur.e2ee_broadcasts enable row level security;
alter table murmur.e2ee_broadcasts force row level security;
alter table murmur.e2ee_broadcast_deliveries enable row level security;
alter table murmur.e2ee_broadcast_deliveries force row level security;

revoke all on table murmur.tenant_e2ee_state
  from public, anon, authenticated, murmur_app;
revoke all on table murmur.tenant_e2ee_usage
  from public, anon, authenticated, murmur_app;
revoke all on table murmur.e2ee_key_bundles
  from public, anon, authenticated, murmur_app;
revoke all on table murmur.e2ee_prekeys
  from public, anon, authenticated, murmur_app;
revoke all on table murmur.e2ee_claims
  from public, anon, authenticated, murmur_app;
revoke all on table murmur.e2ee_messages
  from public, anon, authenticated, murmur_app;
revoke all on table murmur.e2ee_broadcasts
  from public, anon, authenticated, murmur_app;
revoke all on table murmur.e2ee_broadcast_deliveries
  from public, anon, authenticated, murmur_app;

grant select on table murmur.tenant_e2ee_state to murmur_app;
grant select, update on table murmur.tenant_e2ee_usage to murmur_app;
grant select, insert, update, delete on table murmur.e2ee_key_bundles to murmur_app;
grant select, insert, update, delete on table murmur.e2ee_prekeys to murmur_app;
grant select, insert, update, delete on table murmur.e2ee_claims to murmur_app;
grant select, insert, delete on table murmur.e2ee_messages to murmur_app;
grant update(read_at) on table murmur.e2ee_messages to murmur_app;
grant select, insert, update, delete on table murmur.e2ee_broadcasts to murmur_app;
grant select, insert, update, delete on table murmur.e2ee_broadcast_deliveries to murmur_app;

create policy tenant_e2ee_state_current_tenant
on murmur.tenant_e2ee_state for select to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

create policy tenant_e2ee_usage_current_tenant
on murmur.tenant_e2ee_usage for all to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
)
with check (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

create policy e2ee_key_bundles_current_tenant
on murmur.e2ee_key_bundles for all to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
)
with check (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

create policy e2ee_prekeys_current_tenant
on murmur.e2ee_prekeys for all to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
)
with check (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

create policy e2ee_claims_current_tenant
on murmur.e2ee_claims for all to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
)
with check (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

create policy e2ee_messages_current_tenant
on murmur.e2ee_messages for all to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
)
with check (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

create policy e2ee_broadcasts_current_tenant
on murmur.e2ee_broadcasts for all to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
)
with check (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

create policy e2ee_broadcast_deliveries_current_tenant
on murmur.e2ee_broadcast_deliveries for all to murmur_app
using (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
)
with check (
  tenant_id = nullif((select pg_catalog.current_setting('murmur.tenant_id', true)), '')::uuid
);

commit;
