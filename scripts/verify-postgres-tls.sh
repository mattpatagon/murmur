#!/usr/bin/env bash

set -euo pipefail

certificate_directory="$(mktemp -d)"
chmod 755 "$certificate_directory"
container_name="murmur-postgres-tls-$RANDOM-$$"
cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  sudo rm -rf "$certificate_directory"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$certificate_directory/ca.key" \
  -out "$certificate_directory/ca.crt" \
  -days 1 \
  -subj '/CN=Murmur test database CA' >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$certificate_directory/server.key" \
  -out "$certificate_directory/server.csr" \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost' >/dev/null 2>&1
openssl x509 -req \
  -in "$certificate_directory/server.csr" \
  -CA "$certificate_directory/ca.crt" \
  -CAkey "$certificate_directory/ca.key" \
  -CAcreateserial \
  -out "$certificate_directory/server.crt" \
  -days 1 \
  -copy_extensions copy >/dev/null 2>&1
chmod 600 "$certificate_directory/server.key"
sudo chown 999:999 "$certificate_directory/server.key" "$certificate_directory/server.crt"

database_password='murmur_tls_test_password'
docker run --detach \
  --name "$container_name" \
  --env POSTGRES_PASSWORD="$database_password" \
  --publish 127.0.0.1::5432 \
  --volume "$certificate_directory:/certificates:ro" \
  postgres:17 \
  -c ssl=on \
  -c ssl_cert_file=/certificates/server.crt \
  -c ssl_key_file=/certificates/server.key >/dev/null

database_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
database_url="$(MURMUR_TLS_TEST_HOST='localhost' \
  MURMUR_TLS_TEST_PASSWORD="$database_password" \
  MURMUR_TLS_TEST_PORT="$database_port" bun -e '
    const host = process.env.MURMUR_TLS_TEST_HOST;
    const password = process.env.MURMUR_TLS_TEST_PASSWORD;
    const port = process.env.MURMUR_TLS_TEST_PORT;
    if (host === undefined || password === undefined || port === undefined) process.exit(1);
    const url = new URL("postgresql://localhost/postgres");
    url.hostname = host;
    url.port = port;
    url.username = "postgres";
    url.password = password;
    process.stdout.write(url.toString());
  ')"
verified_url="$(MURMUR_DATABASE_CA_PATH="$certificate_directory/ca.crt" \
  MURMUR_DATABASE_URL_TO_VERIFY="$database_url" \
  bun scripts/require-verified-database-url.ts)"
for attempt in {1..30}; do
  if psql "$verified_url" --set ON_ERROR_STOP=1 --command 'select 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 1
done

wrong_host_url="$(MURMUR_TLS_TEST_URL="$database_url" \
  MURMUR_TLS_TEST_CA_PATH="$certificate_directory/ca.crt" bun -e '
    const value = process.env.MURMUR_TLS_TEST_URL;
    const caPath = process.env.MURMUR_TLS_TEST_CA_PATH;
    if (value === undefined || caPath === undefined) process.exit(1);
    const url = new URL(value);
    url.hostname = "127.0.0.1";
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.set("sslrootcert", caPath);
    process.stdout.write(url.toString());
  ')"
if psql "$wrong_host_url" \
  --command 'select 1' >/dev/null 2>&1; then
  echo 'verify-full unexpectedly accepted a certificate for the wrong host' >&2
  exit 1
fi

MURMUR_DATABASE_CA_PATH="$certificate_directory/ca.crt" \
  MURMUR_TLS_TEST_DATABASE_URL="$database_url" \
  bun -e '
    import postgres from "postgres";
    import { postgresSslOptions, postgresTlsConfiguration } from "./src/postgres-tls.ts";
    const url = process.env.MURMUR_TLS_TEST_DATABASE_URL;
    if (url === undefined) throw new Error("TLS test URL is missing");
    const database = postgres(url, {
      connect_timeout: 5,
      max: 1,
      ssl: postgresSslOptions(url, postgresTlsConfiguration(process.env)),
    });
    try {
      await database`select 1`;
    } finally {
      await database.end({ timeout: 1 });
    }
  '

echo 'Verified Postgres TLS fixture passed'
