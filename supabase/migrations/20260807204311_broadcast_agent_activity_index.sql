create index concurrently agents_broadcast_activity
  on murmur.agents(last_seen_at);
