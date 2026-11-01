> Bằng chứng lịch sử 22/10/2026. Xem [lần kiểm chứng 01/11/2026](pd-08-cap-nhat-2026-11-01.md)
> cho service đã tích hợp trực tiếp từ dev; các giới hạn dependency trong bản cũ không còn là trạng thái PD-02 hiện tại.

# Bằng chứng PD-08 — 22/10/2026

## Môi trường và phạm vi

Worktree riêng `D:\pd-08-retry-dlq`, base origin/dev 0f8eae8. Nhánh dùng tên
hung-pd-08-retry-dlq vì ref hung hiện có chặn tên hung/pd-08-retry-dlq.
Giữ nguyên checkout chính và worktree PD-02; không stage file của người khác.
Git author local: Vũ Văn Hùng, 165639660+hungvu205@users.noreply.github.com.

PD-01 đã merge; PD-02 PR #48 còn mở tại lúc kiểm tra. Integration dùng exports
PD-02 checkout riêng ở commit 238b77692f64b502b4ac5761c9b464dee3c91f5d, không đưa
code đó vào nhánh này. Runtime dev chưa có consumer/inbox; patch nối vòng đời
được chuẩn bị riêng, chưa áp dụng vào dev. Không tự merge bất kỳ PR nào.

Docker project riêng pd08-retry: RabbitMQ 3.13 management 15673, AMQP 5673,
PostgreSQL 16 cổng localhost 15432. Không dùng broker 5672 đang có của người dùng.
Tạo override cổng ngoài repo. Không dùng down -v, không purge queue/volume.

## Topology thật

Lệnh: RABBITMQ_MANAGEMENT_URL=http://localhost:15673 node scripts/check-command-topology.mjs

```text
PD-01 Management API verified: vhost /, 2 exchanges, 7 quorum queues, 7 bindings, 2 policy, parking permissions
```

Probe CC riêng quan sát delay 2062/10050 ms, bãi A nhận đúng messageId, B không
nhận, fields.routingKey=retry.1/retry.2, expiration bị broker bỏ. Các exchange/queue
probe đã được xoá sau đo, không chạm queue ứng dụng. Integration dùng topology
definitions thật và xác nhận B/C không có bản sao. Test ban đầu dùng basic.get
trên queue SAC bị RabbitMQ từ chối 405; đã sửa test sang checkQueue để kiểm tra
bãi đối chứng, không đổi topology hay xoá queue để né lỗi.

## Integration broker + PostgreSQL thật

Lệnh và cấu hình tái lập trong runbook. TTL TC57=60000 ms, deadline test riêng=500/50 ms.
Raw TAP: [pd-08-broker-test.log](pd-08-broker-test.log).

```text
TC57 retry intervals ms: 2067 10023
TC57 two transient errors, 2s + 10s, third delivery one committed effect: PASS
TC58 backend invalid schema -> durable DLQ -> ADMIN edit/replay -> one reservation: PASS
Edited replay cannot bypass existing inbox result: PASS
Retry exhaustion -> DLQ; business 409 never retries: PASS
Retry crosses total deadline, no renewal/no late reservation: PASS
Initial queue expiry while node stopped, no late effect: PASS
tests 7; pass 7; fail 0; skipped 0 (includes parent suite)
```

Không dùng publisher confirm để khẳng định nghiệp vụ: test truy vấn reservation
và inbox thật. Replay claim HTTP nội bộ dùng bảng inbox PD-02, xác nhận kết quả cũ
không bị xoá/ghi đè. Test dọn records theo IDs/prefix, dừng consumer trước dọn.

## Giao diện thật

Frontend dist được serve cùng Aggregator thật trên localhost:8308 trong fixture
riêng; node HTTP 8309, consumer PD-02 riêng, broker/DB trên project test. Dùng CUA
đăng nhập admin demo, mở Quản trị → Lệnh lỗi → Xem chi tiết → sửa payload thiếu
biển số thành payload hợp lệ → Đẩy lại. UI READY → PUBLISHING → BROKER_CONFIRMED.
Truy vấn PostgreSQL sau thao tác:

```text
request_id: b8fee2ba-566b-44ab-b6cf-a23d20ade39b:replay-749cb15a382c946cb85e4592587f7366
effects: 1
```

Ảnh: [pd08-dlq.png](anh/pd08-dlq.png). Fixture trả restored=true sau dọn. Đã kiểm
tra desktop; chưa kiểm tra riêng viewport điện thoại. Chưa kiểm chứng kết quả
commands/Socket.IO đầu-cuối PD-03 vì dependency chưa có.

## Unit, HTTP và build

- Module retry/transfer/replay-claim: 10 pass, 0 fail; gồm confirm/return song song,
  nack/disconnect, setup timeout/late connection, parity helper giữa hai service,
  deadline, schema, hook test-only, business 409, claim thiếu inbox/đã có kết quả.
- Commands + DLQ focused: 15 pass (10 commands, 5 DLQ), 0 fail. Kiểm tra persist
  duplicate, che biển số/chữ ký, retry cùng replay ID sau publish fail, phân quyền,
  pagination, validation và không publish intent đã quá hạn.
- HTTP parking-node app.test.js sau thêm endpoint claim: 6 pass, 0 fail.
- Full Aggregator regression: 44 pass, 3 live opt-in skip, 0 fail; sau đó đã thêm
  và chạy test signed deadline riêng thành công. Không coi opt-in skip là pass.
- Full parking-node regression ban đầu: 52 pass, 1 fail (53 test). Lỗi UX-02 cũ
  ở slots.test.js:366 `st.byHour[8]`, actual 2 expected 1. Fixture dùng entered_at
  now()-150 minutes, trùng giờ 08 với fixture cố định tại giờ chạy 10:xx +07.
  Chạy riêng chính test này trên worktree PD-01 nguyên trạng cũng fail 2!==1
  cùng dòng; không sửa test/thống kê ngoài PD-08 để làm xanh giả.
- Frontend npm ci --no-audit --no-fund và npm run build: PASS (Vite 8.3.2).
- git diff --check: PASS. Root không có package.json tracked/npm run check;
  không sử dụng package.json untracked của checkout chính.

## Giới hạn cần giữ khi review

Không tuyên bố PD-08 runtime hoàn chỉnh trên dev khi PD-02 chưa merge/nối consumer.
Hợp đồng deadline với PD-06 vẫn là đề xuất; guard hiện trước processor theo clock
tiến trình, chưa bảo đảm hạn COMMIT sau chờ khoá DB/clock skew. Tin cmd.expired chờ
PD-06; FAILED/commands chờ PD-03 qua hook. Không triển khai toàn bộ TTL/back-pressure
của Trang. CI xem trạng thái thực tế trong PR, không suy diễn từ kết quả local.
