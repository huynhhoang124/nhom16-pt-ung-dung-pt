#!/bin/sh
# PD-14a: Configure synchronous replication for parking D.
set -eu

export PGPASSWORD="${PGPASSWORD:-dev}"

echo "Waiting for primary db-d..."

until psql -h db-d -U postgres -d parking \
  -tAc "SELECT 1" >/dev/null 2>&1; do
  sleep 2
done

echo "Waiting for db-d-replica to stream..."

until psql -h db-d -U postgres -d parking \
  -Atc "SELECT 1 FROM pg_stat_replication WHERE application_name = 'db-d-replica' AND state = 'streaming' LIMIT 1" \
  2>/dev/null | grep -qx '1'; do
  sleep 2
done

echo "Configuring synchronous replication for D..."

psql -h db-d -U postgres -d parking \
  -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET synchronous_standby_names = 'ANY 1 (\"db-d-replica\")'"

psql -h db-d -U postgres -d parking \
  -v ON_ERROR_STOP=1 \
  -c "SELECT pg_reload_conf();"

echo "Synchronous replication D configuration completed."