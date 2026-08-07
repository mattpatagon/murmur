create index concurrently agents_broadcast_machine_activity
  on murmur.agents((metadata ->> 'machine'), last_seen_at);
