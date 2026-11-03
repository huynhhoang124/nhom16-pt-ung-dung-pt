#!/bin/sh
# PD-14a: khoi tao standby bang pg_basebackup -R va chay PostgreSQL replica.

set -eu

: "${PGDATA:=/var/lib/postgresql/data}"
: "${REPLICA_OF:?Missing REPLICA_OF}"
: "${REPLICATION_PASSWORD:?Missing REPLICATION_PASSWORD}"

APPLICATION_NAME="${APPLICATION_NAME:-${REPLICA_OF}-replica}"
export PGDATA

mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until su-exec postgres pg_basebackup \
    --dbname="host=${REPLICA_OF} port=5432 user=replicator password=${REPLICATION_PASSWORD} application_name=${APPLICATION_NAME}" \
    --pgdata="$PGDATA" \
    --write-recovery-conf \
    --wal-method=stream; do

    echo "Chờ primary ${REPLICA_OF} sẵn sàng để sao chép..."
    rm -rf "$PGDATA"/*
    sleep 2
  done
fi

exec docker-entrypoint.sh postgres