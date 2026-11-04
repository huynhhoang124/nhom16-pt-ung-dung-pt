# PD-24 - Distributed tracing voi OpenTelemetry va Jaeger

PD-24 bo sung distributed tracing cho Aggregator, Parking Node va Notification
Service. Tracing duoc bat qua overlay `docker-compose.tracing.yml`; stack mac
dinh van chay duoc khi khong co Collector hoac Jaeger. `tracing.js` chi khoi tao
SDK khi `OTEL_SDK_DISABLED=false`; Compose mac dinh dat `true`, overlay dat `false`.

## Chay stack

```bash
docker compose -f docker-compose.yml -f docker-compose.tracing.yml --profile obs up -d --build
```

Mo Jaeger tai <http://localhost:16686>. Collector nhan OTLP va chuyen trace
den Jaeger.

## Duong di cua trace

1. OpenTelemetry Node SDK duoc preload de tu dong instrument HTTP va PostgreSQL.
2. Aggregator tao `command.publish` trong `commands.send`: ket thuc khi broker confirm,
   khong tinh thoi gian doi reply. Context HTTP duoc luu trong envelope de worker phat sau.
3. Parking Node tao `command.receive` sau khi xac thuc chu ky, instrument PostgreSQL,
   luu HLC va `traceparent` cung parking event, luu reply context truoc khi ky reply.
4. Reply relay tao `command.reply.publish`; Aggregator tao `command.reply.receive`.
   Context di qua `pg_notify` sang `socket.emit` cho `COMMAND_RESULT`, ke ca Aggregator khac.
5. Nhanh su kien van co `outbox.publish`, `event.process` va `socket.emit`.
   Log JSON ghi them `traceId` cung voi `requestId` de tra tu log sang Jaeger.
6. Retry/DLQ giu nguyen `traceparent`; khong sua hop dong HMAC. Reply publish chi
   thay header context (nam ngoai chu ky), khong sua payload da ky trong outbox.

## Kiem thu TC77

```bash
docker compose -f docker-compose.yml -f docker-compose.tracing.yml --profile obs up -d --build
TRACING=1 COMMAND_MODE=broker node --test tests/pd24-tracing.e2e.mjs
```

TC77 tao mot trace dat cho va xac nhan day du chuoi:

`HTTP -> command.publish -> command.receive -> DB -> command.reply.publish -> command.reply.receive -> socket.emit(COMMAND_RESULT)`

Test cung kiem tra nhanh parking event (`outbox.publish -> event.process`).
Test co `skip: !process.env.TRACING`, tra `/api/traces?service=aggregator` va loc
chinh xac trace ID gui trong request. Script in trace ID va URL Jaeger de mo va
chup anh dua vao PR. Can stack da khoi dong xong reply consumer truoc khi chay.
Trong PowerShell: `$env:TRACING='1'; $env:COMMAND_MODE='broker'; node --test tests/pd24-tracing.e2e.mjs`.

B13 chi tiet chi sua file: chua chay test, chua co anh hay bang chung runtime.

## Gioi han

Trace duoc gui bat dong bo va khong thay the Transactional Outbox, log hay
metrics. Cac API nghiep vu khong phu thuoc Collector hoac Jaeger.
