begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- Each branch returns at most one row: bootstrap is a singleton, credential hashes are
-- unique, and every successful intermediate branch returns immediately. The v2 join
-- also uses a unique token identity. The default 1000-row estimate otherwise makes its
-- enrichment join hash the entire credential directory on each authentication request.
alter function murmur.authenticate_principal(bytea) rows 1;
alter function murmur.authenticate_principal_v2(bytea) rows 1;

commit;
