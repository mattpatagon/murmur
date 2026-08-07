create index concurrently messages_broadcast_recipient
  on murmur.messages(broadcast_id, recipient_id)
  where broadcast_id is not null;
