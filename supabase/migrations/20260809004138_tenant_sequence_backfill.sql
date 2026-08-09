set lock_timeout = '5s';
set statement_timeout = '5min';

update murmur.messages
set tenant_sequence = sequence
where tenant_sequence is null;

reset statement_timeout;
reset lock_timeout;
