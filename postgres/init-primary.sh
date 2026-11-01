#!/bin/sh
# PD-14a: Configure replication on a new or existing primary.
# Safe to rerun without deleting database data.

set -eu

: "${PGDATA:=/var/lib/postgresql/data}"

# Create the replication role only if it does not exist.
ROLE_EXISTS=$(psql -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname = 'replicator'")

if [ "$ROLE_EXISTS" != "1" ]; then
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replica';"
  echo "[PD-14a] Created replication role"
else
  echo "[PD-14a] Replication role already exists"
fi

# Avoid adding the same authentication rule more than once.
HBA_RULE="host replication replicator all scram-sha-256"

if ! grep -Fxq "$HBA_RULE" "$PGDATA/pg_hba.conf"; then
  printf '%s\n' "$HBA_RULE" >> "$PGDATA/pg_hba.conf"
  echo "[PD-14a] Added replication authentication rule"
else
  echo "[PD-14a] Replication authentication rule already exists"
fi

# Apply HBA changes without restarting PostgreSQL.
psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT pg_reload_conf();"

echo "[PD-14a] Replication configuration completed"
