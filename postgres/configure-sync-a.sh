#!/bin/sh
set -eu

export PGPASSWORD="${PGPASSWORD:-dev}"

echo "Waiting for primary db-a..."

until psql -h db-a -U postgres -d parking \
  -tAc "SELECT 1" >/dev/null 2>&1; do
  sleep 2
done

echo "Waiting for db-a-replica to stream..."

until psql -h db-a -U postgres -d parking \
  -Atc "SELECT 1 FROM pg_stat_replication WHERE application_name = 'db-a-replica' AND state = 'streaming' LIMIT 1" \
  2>/dev/null | grep -qx '1'; do
  sleep 2
done

echo "Configuring synchronous replication..."

psql -h db-a -U postgres -d parking \
  -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET synchronous_standby_names = 'ANY 1 (\"db-a-replica\")'"

psql -h db-a -U postgres -d parking \
  -v ON_ERROR_STOP=1 \
  -c "SELECT pg_reload_conf();"

echo "Synchronous replication configuration completed."