# PD-03 — Bằng chứng ngày 22/10/2026

## Git/dependency và môi trường

Base origin/dev 0f8eae8356192543eb42323786c522ef33fc7ec9 đã có PD-01. PR #48 PD-02
và #49 PD-08 còn mở, chưa merge tại lúc đọc API. Issue #20 chưa có comment duyệt;
người dùng yêu cầu không chờ Huynh trong chat, không tự đăng hoặc nhận đã duyệt.
Không có AGENTS.md tìm thấy ở repo/parent. Đọc README, kế hoạch v1.4 mục 5.2–5.4,
5.9/phụ lục C, phân công và PR/code PD-01/02/08 trước triển khai.

Worktree riêng D:\pd-03-request-reply; branch hung-pd-03-request-reply do ref hung
đang có chặn slash branch. Checkout chính còn thay đổi của người dùng, không sửa
hoặc stage. Worktree PD-02 và PD-08 giữ sạch. Không merge PR nào.

Docker Desktop ban đầu tắt; đã khởi động phục vụ test. Stack riêng pd03-reply,
RabbitMQ 3.13 cổng 5673/15673; A/B/C/DB riêng; Aggregator 8000 và Aggregator-2 8100.
Không dùng broker 5672 của người dùng. Candidate node trong D:\pd03-node-candidate
gồm source PD-02 238b776, helper/lifecycle retry PD-08 c20c084 và enrichReply PD-03
gắn vào transaction trước INSERT outbox. Không đưa lại các dependency vào Git PD-03.
Broker dùng definitions PD-08; Aggregator/frontend là source PD-03.

Image candidate pd03/parking-node và pd03/aggregator riêng, không ghi đè image
runtime của người dùng. Test dọn theo ID/slot mới riêng. Container bị dừng/kill
đã chạy lại trước khi kết thúc test; cuối buổi compose down **không -v**, giữ volumes.

## HTTP regression toàn bộ

COMMAND_MODE=http cho compose và test; REPLY_WAIT_MS/TTL không ảnh hưởng đường cũ.
Đã bật docker-compose.chaos.yml/profile chaos và CHAOS=1 để chạy cả TC47.
Lệnh: CHAOS=1 node --test tests/e2e.test.mjs. [Raw log](pd-03-http-e2e.log).

```text
tests 13
pass 13
fail 0
skipped 0
```

Bao gồm đặt/idempotency/20 concurrent slot, thanh toán, socket, node/DB/Broker/
Aggregator dừng và phục hồi. Đây là full suite tracked trên base dev, không dùng
package/test untracked của checkout chính.
Lần đầu không bật chaos đạt 12 pass/1 skip; sau đó đã chạy lại full với chaos đạt
13/13, TC47 xác nhận timeout HTTP cũ rồi thử lại cùng key chỉ một hiệu lực.

## Broker integration và failover thật

COMMAND_MODE=broker, COMMAND_TTL_MS=10000, REPLY_WAIT_MS=3000. Hai Aggregator cùng
DB, identity 1/2 riêng; RABBITMQ_URL vhost / (URI /%2F). PD03_BROKER=1.
Lệnh: node --test tests/command-flow.e2e.mjs. [Raw log](pd-03-broker-e2e.log).

```text
TC51 response ms: 531 (log ở cuối validation; HTTP được assert riêng <=3000 ms)
TC51: 201 <=3s, AMQP correlation/trace, owner/admin, slot version: PASS
TC52: 10 HTTP cùng key -> cùng command/result, count reservation=1: PASS
TC54: bãi B dừng 5s -> HTTP 202 -> Socket.IO DONE: PASS
Cancel/pay qua broker, giữ body cũ: PASS
TC62: SIGKILL sender trước reply, aggregator-2 trả DONE/statusCode=201: PASS
TC62 count reservation tại DB C=1: PASS
tests 6; pass 6; fail 0; skipped 0 (gồm parent)
```

Không chỉ GET PENDING: TC62 thật sự chờ DONE, kiểm tra result.id, statusCode, Socket
của instance sống và PostgreSQL count=1. Sau restart sender chờ lease ID cũ hết hạn,
health trở lại trước cleanup. commands trong DB test về count=0 sau dọn.

Lần chạy đầu các testcase nghiệp vụ đều pass nhưng cleanup nhầm bảng payments
(schema giữ thanh toán trên parking_sessions), làm parent fail. Đã sửa cleanup,
dọn đúng fixture đầu P02057, chạy lại toàn bộ: 6/6 pass, commands count=0. Không
xoá volume hoặc thay constraint để né lỗi.

## Management API thực tế

```text
agg.replies.1: durable=true, quorum, x-message-ttl=60000, consumers=1
agg.replies.2: durable=true, quorum, x-message-ttl=60000, consumers=1
agg.replies.recovery: durable=true, quorum, không TTL, consumers=2
```

Node relay publish direct parking.replies, replyTo agg.1/agg.2. Queue recovery
nhận cùng reply để failover; cập nhật commands dedup trước ack. Queue instance
không là nguồn duy nhất của kết quả.

## Frontend thật: 202, reload và terminal

Chạy giao diện qua nginx port 3000, user1 demo của stack test. Tạo slot riêng
QPD03B1 tại B, chọn trên UI; stop parking-b rồi bấm Đặt ngay. Sau 202 thấy Đang
xử lý và commandId b904eb82-f83a-4b66-957c-761d1bd6a182:6ba66cd2-2c38-4fbd-ad53-0a41b0eed9ae.
Reload trang mất state/component ban đầu nhưng banner ID đó vẫn còn. Start B,
banner chuyển Đã hoàn tất; truy vấn PostgreSQL đúng một reservation. Dọn bản ghi
command/inbox/outbox/reservation/events/slot chỉ thuộc fixture; dismiss thông báo,
logout phiên demo. Ảnh [pending](anh/pd03-pending.png) và
[completed sau reload](anh/pd03-completed.png).

UI test dùng TTL=60000 để có thời gian thao tác/ảnh; không thay default 10000 và
không gia hạn retry. Broker automated TC54/62 ở trên vẫn TTL=10000. Chỉ kiểm tra
desktop; chưa kiểm tra viewport nhỏ riêng. Sau UI đã chỉnh câu mô tả offline và
wrapping ID; build/unit chạy lại thành công.

## Unit/regression/build

- Full parking-node: 48 pass, 0 fail, 0 skip (gồm helper enrichReply mới).
- Full Aggregator regression đã quan sát: 45 pass, 3 live opt-in skip, 0 fail
  (48 tests tại thời điểm đó); sau đó bổ sung và chạy focused các cửa sổ DB ACK,
  sau confirm, topology chưa ready và reserved instance ID.
- Focused command-flow/HTTP adapter: 11 pass, 0 fail; kiểm tra reply đến
  trước confirm, duplicate/conflict/late/actor/correlation, cache version, unknown
  vs definite rejection, recover lease trước send/sau confirm, shutdown và DB ACK loss.
- Frontend pure controller: 3 pass/0 fail: 202, cùng key, socket bỏ lỡ/polling,
  reload/reconnect và 503 persistence unknown.
- Frontend npm run build: PASS, Vite 8.3.2; CI frontend bổ sung chạy unit trước build.
- git apply --check patch PD-02: PASS. git diff --check: PASS trước bàn giao.

## Giới hạn giữ nguyên

PR giữ draft: dev hiện chưa có PD-02/PD-08; phải nhận dependency và áp dụng node
reply hook trước khi triển khai broker runtime từ branch này. Không tự nhận đã
hoàn chỉnh runtime trên dev. Không tạo inbox/commands thứ hai hoặc làm thay PD-06.
EXPIRED/FAILED từ expired/DLQ vào commands chưa tích hợp; guard DB clock sau chờ
khoá/clock skew chưa thống nhất. UNKNOWN không bị ép terminal chỉ do timeout.
Hành vi Socket.IO dùng notify + GET phục hồi, không hứa không mất mọi sự kiện socket.
CI thực tế được cập nhật trong PR; local test không thay thế kết quả CI.
