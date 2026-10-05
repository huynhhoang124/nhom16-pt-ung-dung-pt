#!/bin/sh
# PT-02: chạy MỘT lần khi tạo DB bãi A lần đầu: user để bản sao kéo WAL + cho phép kết nối replication.
set -e
psql -v ON_ERROR_STOP=1 -U postgres -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replica'"
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
