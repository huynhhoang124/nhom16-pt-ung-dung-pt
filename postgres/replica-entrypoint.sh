#!/bin/sh
# PT-02: lần đầu chép toàn bộ DB bãi A bằng pg_basebackup (-R: tự tạo standby.signal + thông tin nối bản chính),
# sau đó chạy postgres ở chế độ standby: chỉ đọc, nhận WAL liên tục (streaming, bất đồng bộ).
set -e
mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until su-exec postgres env PGPASSWORD="$REPLICATION_PASSWORD" \
        pg_basebackup -h "$REPLICA_OF" -U replicator -D "$PGDATA" -R -X stream; do
    echo "Chờ $REPLICA_OF sẵn sàng để sao chép..."; rm -rf "$PGDATA"/*; sleep 2
  done
fi
exec docker-entrypoint.sh postgres
