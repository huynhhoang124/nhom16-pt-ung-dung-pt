#!/bin/sh
# PT-03: chỉ dùng cho rabbitmq-2/3. Nút MỚI (volume trống) chờ nút gốc rabbitmq mở cổng 5672 rồi mới khởi động.
# Không chờ thì nút khởi động lúc nút gốc chưa lên sẽ tự lập cụm riêng: classic_config là danh sách cố định nên
# discovery không bao giờ "lỗi" và discovery_retry_limit không có tác dụng (cụm tách, quorum queue thiếu đa số).
# Nút đã có dữ liệu (khởi động lại) thì chạy ngay: nút gốc khởi động lại có thể đang chờ chính nút này.
if [ ! -d "/var/lib/rabbitmq/mnesia/rabbit@$(hostname)" ]; then
  i=0
  until nc -z rabbitmq 5672 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then echo "join-wait: rabbitmq chưa lên sau 180 s, khởi động riêng"; break; fi
    sleep 2
  done
fi
exec docker-entrypoint.sh "$@"
