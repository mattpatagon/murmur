create index concurrently agents_broadcast_repository_activity
  on murmur.agents((metadata ->> 'repository'), last_seen_at);
