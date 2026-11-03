# PD-24 — Distributed tracing với OpenTelemetry và Jaeger

PD-24 bổ sung distributed tracing cho Aggregator, Parking Node và Notification
Service. Mặc định tracing tắt để `docker compose up` không gửi trace tới một
Collector chưa chạy; profile quan sát bật tracing bằng overlay riêng.

## Chạy

```bash
docker compose -f docker-compose.yml -f docker-compose.tracing.yml --profile obs up -d --build
```

Mở Jaeger tại <http://localhost:16686>. Collector nhận OTLP/HTTP nội bộ trên
cổng 4318 và chuyển trace đến Jaeger. Tracing chỉ được bật với
`docker-compose.tracing.yml`; Grafana và Prometheus vẫn chạy theo profile `obs`.
OpenTelemetry chỉ xuất trace; metrics tiếp tục đi qua endpoint Prometheus hiện có.

## Đường đi của trace

1. OpenTelemetry Node SDK được preload trước các thư viện HTTP và PostgreSQL để
   auto-instrumentation bắt các span đó. Span RabbitMQ và inject/extract context
   do ứng dụng quản lý tường minh, tránh auto-instrumentation ghi đè
   `traceparent` trong header nhưng không cập nhật envelope đã ký.
2. Aggregator tạo span Socket.IO khi phát sự kiện. Các thao tác request–reply
   mang `traceparent` trong envelope và header RabbitMQ.
3. Parking Node ghi `traceparent` cùng sự kiện vào `parking_events` trong cùng
   giao dịch nghiệp vụ. Outbox relay tạo producer span, inject context vào
   header RabbitMQ; Aggregator và Notification Service extract context rồi tạo
   consumer span.
4. Log JSON ở các service ghi `traceId` trong context hiện tại cùng
   `requestId`, để tra từ log sang trace trên Jaeger.
5. Saga tạo các span `saga.start`, `saga.execute`, `saga.step` và
   `saga.compensate`; mỗi bước ghi bãi, số thứ tự và hành động để nhìn được cả
   đường bù trừ.

## Kiểm thử TC77 và Saga

Chạy stack có tracing và các dependency PD-03/PD-07 đã tích hợp:

```bash
docker compose -f docker-compose.yml -f docker-compose.tracing.yml --profile obs up -d --build
node tests/pd24-tracing.e2e.mjs
```

Kiểm thử tạo một traceparent có trace ID biết trước, đặt chỗ qua Aggregator,
chờ sự kiện Socket.IO và xác nhận Jaeger có các span HTTP, publish lệnh AMQP,
consumer lệnh tại Parking Node, PostgreSQL, outbox, consumer sự kiện và
`socket.emit`. Sau đó kiểm thử tạo Saga ba bãi với bước cuối thất bại, xác nhận
hai bước trước được bù trừ và trace có `saga.compensate`. Script in URL Jaeger
cho cả hai trace; mở từng URL và chụp ảnh để nộp.
Script đợi `commandsReady` trên `/health` trước khi gửi lệnh, tránh kiểm thử
trong khoảng Aggregator đã mở HTTP nhưng reply-consumer chưa sẵn sàng.

Parking Node hiện đã có command consumer PD-03, inbox transaction và reply
outbox; khi xử lý lệnh, trace context được trích từ envelope và ghi cùng
`parking_events`. Auto-instrumentation AMQP được tắt vì ứng dụng tự tạo span và
truyền context trên cả envelope lẫn header đã ký; bật đồng thời sẽ khiến
instrumentation ghi đè header `traceparent` mà không sửa envelope. Script E2E
đã xác nhận đủ span TC77 và Saga bù trừ trên stack Docker/Jaeger.

## Giới hạn

Trace được gửi bất đồng bộ và không thay thế Transactional Outbox, log hay
metrics. Khi `obs` không chạy, không bật overlay tracing; các API nghiệp vụ
không phụ thuộc Collector hoặc Jaeger.
