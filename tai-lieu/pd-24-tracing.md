# PD-24 - Distributed tracing voi OpenTelemetry va Jaeger

PD-24 bo sung distributed tracing cho Aggregator, Parking Node va Notification
Service. Tracing duoc bat qua overlay `docker-compose.tracing.yml`; stack mac
dinh van chay duoc khi khong co Collector hoac Jaeger.

## Chay stack

```bash
docker compose -f docker-compose.yml -f docker-compose.tracing.yml --profile obs up -d --build
```

Mo Jaeger tai <http://localhost:16686>. Collector nhan OTLP va chuyen trace
den Jaeger.

## Duong di cua trace

1. OpenTelemetry Node SDK duoc preload de tu dong instrument HTTP va PostgreSQL.
2. Aggregator tao span cho request dat cho, publish command va `socket.emit`.
3. Parking Node ghi `traceparent` vao outbox/parking event. Relay dat context
   vao header AMQP va tao span `outbox.publish`.
4. Parking Node tao span `command.receive`; Aggregator tao span xu ly event.
5. Log JSON ghi them `traceId` cung voi `requestId` de tra tu log sang Jaeger.

## Kiem thu TC77

```bash
docker compose -f docker-compose.yml -f docker-compose.tracing.yml --profile obs up -d --build
node tests/pd24-tracing.e2e.mjs
```

TC77 tao mot trace dat cho va xac nhan day du chuoi:

`HTTP -> DB -> outbox -> AMQP -> Parking Node -> event.process -> socket.emit`

Script in trace ID va URL Jaeger de mo va chup anh dua vao PR. Script doi
`commandsReady` tren `/health` truoc khi gui lenh, tranh race condition khi
reply consumer chua san sang.

## Gioi han

Trace duoc gui bat dong bo va khong thay the Transactional Outbox, log hay
metrics. Cac API nghiep vu khong phu thuoc Collector hoac Jaeger.
