# Áp dụng vào BTL – Bãi đỗ xe thông minh liên kết nhiều bãi (Nhóm 16)

Đây là bản **tổng hợp để làm bài**: lý thuyết (xem `ly-thuyet-ap-dung-xuyen-suot.md`) đã được chuyển thành **quyết định cụ thể, schema, API, code mẫu, test, kịch bản demo và dàn báo cáo**, bám theo `Ke_hoach_trien_khai.pdf` (33 trang) và `Nhom16_Mo_hinh_HLD.pdf`.

> **Trạng thái kiểm chứng:** schema SQL, `reserve`, `moveSlot` và `relay` (mục 3, 5.1–5.3) đã chạy thử trên PostgreSQL thật (PGlite) với 15 kiểm tra, **đạt hết**. Đoạn Aggregator (5.4), Docker Compose (mục 6) và kiểm thử song song thật (TC09) **chưa chạy**. Chi tiết ở mục 12.

---

## 0. Việc cần nhóm chốt trước khi code

Kế hoạch (PDF 33 trang) và HLD (PDF 3 trang) **lệch nhau ở 3 điểm**:

| # | Kế hoạch 33 trang | HLD mới | Đề xuất mặc định (đã dùng trong file này) |
|---|---|---|---|
| 1 | Chỉ HTTP + WebSocket; "message broker" là *hướng phát triển* (mục 39) | Có **Message Broker AMQP** | **Bản 1: không broker**, relay đẩy sự kiện bằng HTTP tới Aggregator. **Bản 2 (nếu còn thời gian):** thay bằng RabbitMQ, chỉ đổi hàm `publish()` trong relay. Cả hai đều là Transactional Outbox, đều at-least-once, tiêu chí chấp nhận vẫn đạt. |
| 2 | Aggregator **không lưu** trạng thái slot, DB Aggregator chỉ có `parking_nodes` | Có "DB Aggregator" gồm tài khoản, vai trò | `parking_nodes` + `users` trong DB Aggregator. Trạng thái slot ở Aggregator chỉ là **cache trong RAM** (chỉ-đọc, dựng lại được từ node) |
| 3 | Phân công cho **4** người | Nhóm có **6** người | Đề xuất ở mục 10, nhóm tự điều chỉnh |

Hai câu hỏi còn mở (cần nhóm quyết): **STAFF** gọi qua Aggregator hay gọi thẳng Node? (đề xuất: qua Aggregator, ghi "Aggregator sập thì không xác nhận được xe vào/ra" là *hạn chế đã biết*); **Frontend** có cần làm hết 4 trang không? (đề xuất: Dashboard + Chi tiết bãi + Đặt chỗ trước, Admin làm sau cùng).

---

## 1. Kiến trúc và cấu trúc project

```
smart-parking-distributed/
├── frontend/              React (3000)
├── aggregator-service/    Express (8000) + DB aggregator (Postgres)
├── parking-node/          MỘT image, chạy 3 instance A/B/C (8001/8002/8003)
├── docker-compose.yml
└── docs/
```
Luồng: `Frontend → Aggregator → Node → DB bãi`; sự kiện: `Node (events/outbox) → relay → Aggregator → WebSocket → Frontend`.

Tiêu chí chấp nhận của đề (kế hoạch mục 33/38) và bằng chứng nộp:

| Tiêu chí | Bằng chứng |
|---|---|
| ≥ 2 thành phần độc lập giao tiếp qua mạng | `docker compose ps` thấy aggregator + parking-a/b/c chạy riêng, gọi nhau bằng HTTP |
| Dữ liệu phân tán thật | 3 Postgres riêng (`db-a/b/c`), node không có connection string của DB khác |
| Nghiệp vụ không chỉ CRUD | tra cứu scatter–gather, đặt chỗ chống trùng, xe vào/ra, node lỗi/phục hồi |
| Một node lỗi không làm sập hệ | demo tắt `parking-b` (mục 9) |
| Thêm node mới | thêm 1 dòng vào `NODES` + 1 service trong compose, không sửa code |

---

## 2. Mô hình hệ thống cần khai báo trong báo cáo

| | Giả định | Vì sao ảnh hưởng thiết kế |
|---|---|---|
| Mạng | fair-loss (mất/trùng/đảo thứ tự, thử lại thì tới) | cần retry, idempotent, version |
| Node | crash-recovery (RAM mất, DB còn) | ghi DB trước, phản hồi sau |
| Thời gian | partially synchronous | dùng timeout nhưng coi OFFLINE có thể sai |

---

## 3. Schema (PostgreSQL)

### 3.1 DB mỗi bãi (3 DB cùng schema)
```sql
CREATE TABLE parking_slots (
  id          SERIAL PRIMARY KEY,
  slot_code   VARCHAR(10) UNIQUE NOT NULL,                 -- A01, A02...
  floor       INT NOT NULL DEFAULT 1,
  type        VARCHAR(12) NOT NULL DEFAULT 'CAR',          -- CAR/MOTORBIKE
  status      VARCHAR(12) NOT NULL DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE')),
  version     BIGINT NOT NULL DEFAULT 0,                   -- tăng mỗi lần đổi (sắp thứ tự sự kiện)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    VARCHAR(64) UNIQUE NOT NULL,               -- Idempotency-Key
  user_id       VARCHAR(64) NOT NULL,
  slot_id       INT NOT NULL REFERENCES parking_slots(id),
  license_plate VARCHAR(20) NOT NULL,
  start_time    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expire_time   TIMESTAMPTZ NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','USED','CANCELLED','EXPIRED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Lớp bảo vệ cuối cùng ở tầng DB: một slot chỉ có tối đa 1 reservation ACTIVE
CREATE UNIQUE INDEX ux_one_active_per_slot ON reservations(slot_id) WHERE status='ACTIVE';

CREATE TABLE parking_events (                              -- vừa là lịch sử, vừa là OUTBOX
  id            BIGSERIAL PRIMARY KEY,                     -- thứ tự gửi
  event_type    VARCHAR(20) NOT NULL,                      -- CAR_ENTER/CAR_EXIT/RESERVED/CANCELLED/EXPIRED
  slot_code     VARCHAR(10) NOT NULL,
  license_plate VARCHAR(20),
  payload       JSONB NOT NULL,                            -- {event:'SLOT_UPDATED',parkingId,slot,status,version}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ                                -- NULL = chưa gửi
);
CREATE INDEX ix_events_unpublished ON parking_events(id) WHERE published_at IS NULL;
```
Không xoá cứng reservation: huỷ/hết hạn = đổi `status` (dấu vết để đối soát, đúng tinh thần *tombstone*).

### 3.2 DB Aggregator
```sql
CREATE TABLE parking_nodes (
  parking_id VARCHAR(8) PRIMARY KEY, name TEXT, api_url TEXT NOT NULL, address TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION
);   -- status/last_seen giữ trong RAM (thay đổi mỗi 5s, không cần ghi DB)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role VARCHAR(8) NOT NULL CHECK (role IN ('USER','STAFF','ADMIN'))
);
```

---

## 4. API (giữ nguyên kế hoạch, thêm 4 chi tiết)

**Parking Node:** `GET /health` · `GET /api/availability` · `GET /api/slots` (nay trả cả `slotCode`, `status`, `version`) · `GET /api/slots/available` · `POST /api/reservations` · `POST /api/slots/{slotCode}/enter` · `POST /api/slots/{slotCode}/exit` · `DELETE /api/reservations/{id}`.

**Aggregator:** `GET /api/parkings` · `GET /api/parkings/availability` · `GET /api/parkings/search?available=true` · `GET /api/parkings/{id}` · `POST /api/parkings/{id}/reservations` · nội bộ: `POST /internal/events`.

**4 chi tiết thêm từ lý thuyết:**
1. `POST …/reservations` **bắt buộc** header `Idempotency-Key` (client sinh UUID mỗi lần bấm "Đặt", **giữ nguyên khi retry**). Thiếu → `400`.
2. Mã lỗi có nghĩa: `409 SLOT_TAKEN` (hết slot) · `503 PARKING_OFFLINE` (node OFFLINE, từ chối ngay) · `504 TIMEOUT_UNKNOWN_RESULT` (Aggregator hết giờ chờ node: **chưa biết** đã đặt hay chưa → client retry cùng key).
3. Kết quả tra cứu một phần: bãi lỗi trả `{"parkingId":"B","status":"OFFLINE"}`, bãi tốt trả `status:"ONLINE"` + số liệu.
4. Gọi nội bộ Aggregator↔Node và Node→Aggregator kèm `x-internal-key`.

---

## 5. Code mẫu (Node.js + Express + `pg`; Node ≥ 18)

### 5.1 Node – đặt chỗ (chống trùng + idempotent + outbox, một giao dịch)
```js
// parking-node/reserve.js
const emit = (c, parkingId, type, slotCode, status, version, plate) =>
  c.query(
    `INSERT INTO parking_events(event_type, slot_code, license_plate, payload)
     VALUES ($1,$2,$3,$4)`,
    [type, slotCode, plate ?? null,
     { event: 'SLOT_UPDATED', parkingId, slot: slotCode, status, version }]);

async function reserve(pool, parkingId, { requestId, userId, slotCode, licensePlate }) {
  const prior = await pool.query('SELECT * FROM reservations WHERE request_id=$1', [requestId]);
  if (prior.rowCount) return { code: 200, body: prior.rows[0], replayed: true };   // retry an toàn

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const s = await c.query(                          // compare-and-swap nguyên tử
      `UPDATE parking_slots SET status='RESERVED', version=version+1, updated_at=now()
       WHERE slot_code=$1 AND status='AVAILABLE' RETURNING id, version`, [slotCode]);
    if (!s.rowCount) { await c.query('ROLLBACK'); return { code: 409, body: { error: 'SLOT_TAKEN' } }; }

    const r = await c.query(
      `INSERT INTO reservations(request_id,user_id,slot_id,license_plate,expire_time)
       VALUES ($1,$2,$3,$4, now() + interval '15 minutes') RETURNING *`,
      [requestId, userId, s.rows[0].id, licensePlate]);
    await emit(c, parkingId, 'RESERVED', slotCode, 'RESERVED', s.rows[0].version, licensePlate);
    await c.query('COMMIT');
    return { code: 201, body: r.rows[0] };
  } catch (e) {
    await c.query('ROLLBACK');
    if (e.code === '23505') {                          // hai request cùng requestId đua nhau
      const again = await pool.query('SELECT * FROM reservations WHERE request_id=$1', [requestId]);
      if (again.rowCount) return { code: 200, body: again.rows[0], replayed: true };
      return { code: 409, body: { error: 'SLOT_TAKEN' } };   // vi phạm ux_one_active_per_slot
    }
    throw e;
  } finally { c.release(); }
}
module.exports = { reserve, emit };
```
Vì sao đủ an toàn: `UPDATE … WHERE status='AVAILABLE'` lấy khoá dòng nên hai người đặt cùng lúc chỉ **một** thấy 1 dòng bị ảnh hưởng; `ux_one_active_per_slot` là lưới đỡ thứ hai ở DB.

### 5.2 Node – xe vào/ra, huỷ, hết hạn (cùng khuôn)
```js
// đổi trạng thái slot + ghi event trong 1 giao dịch
async function moveSlot(pool, parkingId, slotCode, from, to, type, plate) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const s = await c.query(
      `UPDATE parking_slots SET status=$3, version=version+1, updated_at=now()
       WHERE slot_code=$1 AND status = ANY($2) RETURNING version`, [slotCode, from, to]);
    if (!s.rowCount) { await c.query('ROLLBACK'); return { code: 409, body: { error: 'INVALID_STATE' } }; }
    if (type === 'CAR_ENTER')                          // reservation ACTIVE -> USED
      await c.query(`UPDATE reservations SET status='USED' WHERE status='ACTIVE'
                     AND slot_id=(SELECT id FROM parking_slots WHERE slot_code=$1)`, [slotCode]);
    await require('./reserve').emit(c, parkingId, type, slotCode, to, s.rows[0].version, plate);
    await c.query('COMMIT');
    return { code: 200, body: { slot: slotCode, status: to, version: s.rows[0].version } };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
// enter: moveSlot(..., ['RESERVED','AVAILABLE'], 'OCCUPIED', 'CAR_ENTER')
// exit : moveSlot(..., ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT')
// huỷ reservation: đổi reservations.status='CANCELLED' + moveSlot(['RESERVED'],'AVAILABLE','CANCELLED') (cùng giao dịch khi hoàn thiện)
```
Hết hạn (chạy mỗi 30 s trong node, dùng **đồng hồ DB của chính node**):
```sql
UPDATE reservations SET status='EXPIRED' WHERE status='ACTIVE' AND expire_time < now() RETURNING slot_id;
-- với mỗi slot_id: UPDATE parking_slots SET status='AVAILABLE', version=version+1 WHERE id=$1 AND status='RESERVED'; rồi emit event
```

### 5.3 Node – relay outbox (đẩy sự kiện lên Aggregator)
```js
// parking-node/relay.js   (mỗi node chạy đúng 1 relay => giữ được thứ tự theo id)
let running = false;
async function relayOnce(pool, aggUrl, key) {
  if (running) return; running = true;
  try {
    const { rows } = await pool.query(
      'SELECT id, payload FROM parking_events WHERE published_at IS NULL ORDER BY id LIMIT 100');
    for (const e of rows) {
      const ok = await fetch(aggUrl + '/internal/events', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify(e.payload), signal: AbortSignal.timeout(2000),
      }).then(r => r.ok).catch(() => false);
      if (!ok) break;                                  // dừng, giữ thứ tự, lần sau gửi lại từ đây
      await pool.query('UPDATE parking_events SET published_at=now() WHERE id=$1', [e.id]);
    }
  } finally { running = false; }
}
module.exports = { relayOnce };
// setInterval(() => relayOnce(pool, AGG_URL, KEY), 1000);
```
Chết giữa lúc gửi và lúc đánh dấu → lần sau gửi **trùng**; không sao vì Aggregator bỏ qua tin có `version` không lớn hơn. *(Bản 2: thay `fetch` bằng `channel.publish` + publisher confirm; phần còn lại giữ nguyên.)*

### 5.4 Aggregator – health check, tra cứu song song, định tuyến, nhận sự kiện, đối soát
```js
// aggregator-service/index.js (rút gọn)
const KEY = process.env.INTERNAL_KEY;
const nodes = new Map();          // id -> { id, url, status:'ONLINE'|'OFFLINE', fails, lastSeen }
const cache = new Map();          // 'A:A05' -> { status, version }   (RAM, dựng lại từ node)

const call = (n, path, opts = {}, ms = 2000) =>
  fetch(n.url + path, { ...opts, signal: AbortSignal.timeout(ms),
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, ...opts.headers } });

// Health check: OFFLINE sau 3 lần liên tiếp thất bại (giảm báo nhầm); sống lại -> đối soát
setInterval(() => Promise.all([...nodes.values()].map(async n => {
  const ok = await call(n, '/health', {}, 1500).then(r => r.ok).catch(() => false);
  if (ok) { const was = n.status; n.fails = 0; n.status = 'ONLINE'; n.lastSeen = Date.now();
            if (was === 'OFFLINE') reconcile(n).catch(() => {}); }
  else if (++n.fails >= 3) n.status = 'OFFLINE';
})), 5000);

// Nghiệp vụ 1: tra cứu song song + kết quả một phần
app.get('/api/parkings/availability', async (_req, res) => {
  res.json(await Promise.all([...nodes.values()].map(async n => {
    if (n.status === 'OFFLINE') return { parkingId: n.id, status: 'OFFLINE' };
    try { const r = await call(n, '/api/availability'); if (!r.ok) throw 0;
          return { parkingId: n.id, status: 'ONLINE', ...(await r.json()) }; }
    catch { return { parkingId: n.id, status: 'OFFLINE' }; }      // timeout -> bỏ qua, vẫn trả phần còn lại
  })));
});

// Nghiệp vụ 2: định tuyến thẳng tới node, từ chối ngay nếu OFFLINE
app.post('/api/parkings/:id/reservations', auth('USER'), async (req, res) => {
  const n = nodes.get(req.params.id); if (!n) return res.sendStatus(404);
  const requestId = req.get('Idempotency-Key');
  if (!requestId) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
  if (n.status === 'OFFLINE') return res.status(503).json({ error: 'PARKING_OFFLINE' });
  try {
    const r = await call(n, '/api/reservations', { method: 'POST',
      body: JSON.stringify({ ...req.body, userId: req.user.id, requestId }) }, 3000);
    res.status(r.status).json(await r.json());
  } catch { res.status(504).json({ error: 'TIMEOUT_UNKNOWN_RESULT', hint: 'retry with same Idempotency-Key' }); }
});

// Nhận sự kiện: trùng/cũ tự bị bỏ nhờ version; luôn 204 để relay đánh dấu đã gửi
app.post('/internal/events', internal, (req, res) => {
  const e = req.body, k = `${e.parkingId}:${e.slot}`, cur = cache.get(k);
  if (!cur || e.version > cur.version) { cache.set(k, { status: e.status, version: e.version }); io.emit('SLOT_UPDATED', e); }
  res.sendStatus(204);
});

// Đối soát khi node sống lại (và khi Aggregator khởi động): lấy bản có version lớn hơn cho từng slot
async function reconcile(n) {
  for (const s of await (await call(n, '/api/slots')).json()) {
    const k = `${n.id}:${s.slotCode}`, cur = cache.get(k);
    if (!cur || s.version > cur.version) {
      cache.set(k, { status: s.status, version: s.version });
      io.emit('SLOT_UPDATED', { event: 'SLOT_UPDATED', parkingId: n.id, slot: s.slotCode, status: s.status, version: s.version });
    }
  }
}
```
Điểm lý thuyết trong code: `AbortSignal.timeout` = timeout theo bộ đếm monotonic của runtime (không bị giờ hệ thống nhảy); `version > cur.version` = idempotent + chống đảo thứ tự; `reconcile` = anti-entropy với phép gộp "lấy version lớn hơn" (giao hoán, kết hợp, idempotent).

**Ghi chú so với bản lý thuyết:** file lý thuyết nói dùng `event_id` để khử trùng. Ở đây `version` per-slot đã đủ (mỗi slot chỉ có 1 người ghi nên `version` tăng một chiều) → bỏ `event_id`, đỡ một bảng/Set.

---

## 6. Docker Compose (khung)
```yaml
services:
  db-a: &pg { image: postgres:16, environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: parking },
              healthcheck: { test: ["CMD-SHELL","pg_isready -U postgres"], interval: 3s, retries: 10 } }
  db-b: *pg
  db-c: *pg
  db-agg: *pg
  parking-a: &node
    build: ./parking-node
    environment: { PARKING_ID: A, PORT: 8001, DATABASE_URL: "postgres://postgres:dev@db-a/parking",
                   AGGREGATOR_URL: "http://aggregator:8000", INTERNAL_KEY: dev, SLOT_COUNT: 20, SLOT_PREFIX: A }
    depends_on: { db-a: { condition: service_healthy } }
    ports: ["8001:8001"]
  parking-b: { <<: *node, depends_on: { db-b: { condition: service_healthy } }, ports: ["8002:8002"],
               environment: { PARKING_ID: B, PORT: 8002, DATABASE_URL: "postgres://postgres:dev@db-b/parking",
                              AGGREGATOR_URL: "http://aggregator:8000", INTERNAL_KEY: dev, SLOT_COUNT: 30, SLOT_PREFIX: B } }
  parking-c: { <<: *node, depends_on: { db-c: { condition: service_healthy } }, ports: ["8003:8003"],
               environment: { PARKING_ID: C, PORT: 8003, DATABASE_URL: "postgres://postgres:dev@db-c/parking",
                              AGGREGATOR_URL: "http://aggregator:8000", INTERNAL_KEY: dev, SLOT_COUNT: 15, SLOT_PREFIX: C } }
  aggregator:
    build: ./aggregator-service
    environment: { PORT: 8000, DATABASE_URL: "postgres://postgres:dev@db-agg/parking", INTERNAL_KEY: dev }
    depends_on: { db-agg: { condition: service_healthy } }
    ports: ["8000:8000"]
  frontend: { build: ./frontend, ports: ["3000:3000"], depends_on: [aggregator] }
```
Node khi khởi động: chạy schema (3.1) nếu chưa có, rồi seed `SLOT_COUNT` slot (`INSERT … ON CONFLICT (slot_code) DO NOTHING`). Mật khẩu `dev`/key `dev` chỉ cho môi trường demo.

---

## 7. Giai đoạn triển khai (kế hoạch 7 giai đoạn + phần lý thuyết)

| GĐ | Làm | Xong khi |
|---|---|---|
| 1 | Parking Node: schema, slots, reserve (5.1), enter/exit (5.2) | curl đặt chỗ/vào/ra trên 1 node; TC02, TC03, TC06, TC07 qua |
| 2 | Nhân thành 3 node (env khác nhau, DB riêng) | 3 node chạy độc lập |
| 3 | Aggregator: registry, health check, tra cứu song song, định tuyến | TC01, TC04, TC05 qua |
| 4 | Outbox relay (5.3) + `/internal/events` + reconcile | TC08–TC12 (mục 8) qua |
| 5 | Frontend + WebSocket | Dashboard cập nhật khi xe vào/ra |
| 6 | Fault tolerance: kill/restart `parking-b`, chạy kịch bản demo | demo 4 và 5 chạy đúng |
| 7 | Docker hoá toàn bộ | `docker compose up` là chạy |
| 8 *(tuỳ chọn)* | Thay HTTP relay bằng RabbitMQ | cùng bộ test vẫn qua |

---

## 8. Kiểm thử

**Từ kế hoạch:** TC01 tra cứu nhiều node · TC02 đặt slot · TC03 hai người cùng đặt · TC04 tắt B · TC05 bật lại B · TC06 xe vào · TC07 xe ra.

**Thêm từ lý thuyết (đây là chỗ chứng minh phần "phân tán"):**

| TC | Việc | Mong đợi | Lý thuyết |
|---|---|---|---|
| TC08 | Gửi **2 lần cùng `Idempotency-Key`** | cả hai `201/200`, cùng reservation id, DB chỉ 1 dòng | idempotent / exactly-once về hiệu quả |
| TC09 | **20 request song song** cùng slot | đúng **1×201, 19×409** | atomic update / chống trùng |
| TC10 | Tắt Aggregator → đặt chỗ ở node A → bật lại | `published_at IS NULL` lúc tắt; sau khi bật, ≤ vài giây sự kiện tới, UI cập nhật | outbox không mất tin |
| TC11 | POST `/internal/events` với `version` 5 rồi 4 (cùng slot) | tin version 4 bị bỏ | chống đảo thứ tự + chống trùng |
| TC12 | Aggregator gọi node nhưng ngắt giữa chừng (hoặc hạ timeout rất thấp) | `504 TIMEOUT_UNKNOWN_RESULT`; retry cùng key không tạo reservation thứ hai | hai tướng quân |
| TC13 | B sống lại sau khi có thay đổi lúc offline | sau health check, Aggregator đối soát: cache khớp DB bãi B | anti-entropy |
| TC14 | Làm B chậm (không tắt) khiến health check thất bại 3 lần | B bị đánh dấu OFFLINE; đặt chỗ ở B bị từ chối; **không có đặt trùng** | failure detector có thể nhầm nhưng vẫn an toàn |

Lệnh mẫu (bash) cho TC09, **chưa chạy thử**:
```bash
seq 1 20 | xargs -P20 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST localhost:8001/api/reservations -H 'content-type: application/json' -H 'x-internal-key: dev' \
  -d '{"requestId":"req-{}","userId":"u{}","slotCode":"A01","licensePlate":"30A-{}"}' | sort | uniq -c
# kỳ vọng:  1 201  /  19 409
```

---

## 9. Kịch bản demo (kèm câu nói gắn lý thuyết)

| Demo | Làm | Nói gì |
|---|---|---|
| 1 | Chạy đủ A, B, C, Aggregator, Frontend; xem Dashboard | "Ba bãi, ba DB riêng, người dùng chỉ thấy một hệ thống – **trong suốt vị trí**." |
| 2 | Cho xe vào A01 | "Node ghi DB và sự kiện **cùng một giao dịch** (outbox), relay đẩy lên, Aggregator đẩy WebSocket." |
| 3 | Đặt B05; rồi bấm đặt B05 **hai lần/hai tab** | "Một DB, một `UPDATE` có điều kiện → chỉ một thành công; **không cần 2PC** vì không có giao dịch xuyên bãi." |
| 4 | `docker compose stop parking-b` | "Health check = failure detector; B OFFLINE, A và C chạy, tra cứu trả kết quả **một phần**. Ghi bị từ chối (chọn C), đọc vẫn trả (chọn A) – **CAP khi có partition**." |
| 5 | Trong lúc B tắt, thử đặt B → `503`. Bật B | "Sau health check B ONLINE, Aggregator **đối soát** snapshot, lấy bản `version` lớn hơn." |
| 6 *(thêm)* | Gửi lại yêu cầu đặt với cùng `Idempotency-Key` | "Timeout thì **không biết** kết quả (hai tướng quân) → retry an toàn nhờ idempotency." |

---

## 10. Phân công 6 người (đề xuất, nhóm tự điều chỉnh)

| Thành viên | Phần chính | Kèm |
|---|---|---|
| Vũ Văn Hùng | **Parking Node + DB** (schema, reserve, enter/exit, hết hạn) | TC02, 03, 06, 07, 08, 09 |
| Hoàng Văn Huynh | **Aggregator** (registry, health check, scatter–gather, routing, JWT) | TC01, 04, 05, 12, 14 |
| Nguyễn Văn Luân | **Frontend** (Dashboard, chi tiết bãi, đặt chỗ) | nhận WebSocket |
| Trịnh Kim Loan | **Outbox relay + events + WebSocket + reconcile** | TC10, 11, 13 |
| Đỗ Huyền Trang | **Docker Compose, seed dữ liệu, kịch bản demo** | demo 1–6 |
| Phạm Sỹ Hiệp | **Báo cáo + sơ đồ + sửa HLD** (mục 11), Admin page | slide/vấn đáp |

Mỗi người đã có nhánh riêng trong repo (`hung`, `luan`, `loan`, `trang`, `hiep`, và `main` của Huynh). Gộp vào `main` bằng PR.

---

## 11. Dàn báo cáo và câu trả lời mẫu

| Mục báo cáo | Nội dung | Gắn lý thuyết |
|---|---|---|
| 1. Giới thiệu, bối cảnh | từ kế hoạch mục 1–2 | — |
| 2. Mô hình hệ thống | bảng ở mục 2 | mô hình mạng/node/thời gian |
| 3. Kiến trúc (sơ đồ `so-do/`) | Client – Aggregator – Node – DB; phần tập trung/phân tán | shared-nothing, SPOF |
| 4. **Vì sao phân tán** (HLD Câu 1) | dữ liệu sinh ra tại bãi, cô lập lỗi, mở rộng, tự chủ | + nêu cái giá: lỗi bất định |
| 5. **Phân tán ở đâu** (Câu 2) | 4 lớp: dữ liệu, xử lý, triển khai, luồng tin | sharding ≠ replication |
| 6. **Giải pháp phân tán** (Câu 3) | định tuyến, scatter–gather, nhất quán trong site, chịu lỗi, trong suốt | CAP, outbox, idempotent |
| 7. Thiết kế DB và API | mục 3–4 | version, idempotency key |
| 8. Xử lý tương tranh | `UPDATE … WHERE`, `ux_one_active_per_slot` | linearizable trong 1 bản |
| 9. Chịu lỗi và phục hồi | health check, từ chối ghi, reconcile | failure detector, anti-entropy |
| 10. Kiểm thử và demo | TC01–TC14, demo 1–6 | — |
| 11. Hạn chế và hướng mở rộng | Aggregator/DB/Broker là SPOF; chưa nhân bản DB bãi | replication, quorum, Raft |

Câu trả lời mẫu ngắn (đủ để thuộc):
- **Chống đặt trùng?** "Một `UPDATE … WHERE status='AVAILABLE'` trong một giao dịch của DB bãi; thêm unique index một reservation ACTIVE cho mỗi slot."
- **Vì sao không 2PC?** "Mỗi lượt đặt chỉ chạm một DB; 2PC chỉ cần khi giao dịch xuyên nhiều node và nó còn chặn khi coordinator sập."
- **Mạng chập chờn khi đặt chỗ?** "Aggregator timeout thì không biết node đã commit chưa; client retry cùng `Idempotency-Key`, DB chặn bản thứ hai."
- **B sập thì sao?** "OFFLINE sau 3 lần health check lỗi; ghi bị từ chối, đọc trả kết quả một phần; A, C không ảnh hưởng; B sống lại thì đối soát."
- **Health check báo nhầm?** "Chỉ làm từ chối thừa, không bao giờ làm đặt trùng."
- **CAP?** "Khi có partition: ghi chọn nhất quán (từ chối), đọc chọn sẵn sàng (trả một phần). Trong từng bãi chỉ có một bản dữ liệu nên nhất quán là hiển nhiên."

---

## 12. Sửa tài liệu cũ và những gì chưa kiểm chứng

**Việc sửa trong HLD/kế hoạch** (gộp README + phát hiện mới):
- [ ] Kế hoạch: phân công 4 → 6 người (mục 10).
- [ ] HLD Câu 2: ghi "bốn lớp" nhưng bảng có 6 dòng.
- [ ] HLD trang 2 vs 3: Aggregator "không giữ dữ liệu slot" nhưng có "trạng thái tổng hợp/đối soát" → ghi rõ: cache RAM chỉ-đọc, nguồn gốc ở DB bãi.
- [ ] HLD: STAFF đi qua Aggregator → ghi hạn chế hoặc cho gọi thẳng Node.
- [ ] HLD: "phân mảnh dọc SLOT_DEF/SLOT_STATE" thực chất là tách bảng trong site.
- [ ] HLD Câu 3: sửa câu CAP (chỉ chọn khi có partition); thêm khai báo mô hình hệ thống.
- [ ] Thống nhất broker: kế hoạch ghi "hướng phát triển", HLD ghi có. Quyết định theo mục 0.

**Đã kiểm chứng** (Node 24 + PGlite = PostgreSQL thật chạy bằng WASM, 1 kết nối): 15/15 kiểm tra đạt
- Schema tạo được, kể cả partial unique index `ux_one_active_per_slot` (chèn reservation ACTIVE thứ hai cho cùng slot → lỗi `23505`).
- `reserve`: 201; gửi lại cùng `requestId` → trả bản cũ, vẫn 1 dòng (TC08); người thứ hai cùng slot → 409 và không sinh thêm reservation hay event.
- `moveSlot`: enter/exit/walk-in đúng trạng thái và `version` tăng 1,2,3; exit sai trạng thái → 409; reservation ACTIVE → USED khi xe vào.
- Event chỉ sinh khi thao tác thành công; thứ tự `version` đúng.
- `relayOnce`: server trả 500 → không đánh dấu đã gửi; server khỏe lại → gửi đủ 4 tin đúng thứ tự và đánh dấu; chạy lại không gửi lặp.
- Cú pháp cả 4 đoạn JS qua `node --check`.

**Chưa kiểm chứng**
- **Tranh chấp song song thật (TC09)**: PGlite chỉ có một kết nối nên chưa chứng minh được 20 request đồng thời chỉ 1 thành công. Logic dựa trên khoá dòng của `UPDATE … WHERE` + unique index, cần chạy với Postgres thật (`docker compose up db-a` rồi chạy lệnh ở mục 8). Nhánh `23505` do hai request cùng `requestId` đua nhau cũng chưa kích hoạt được.
- **Đoạn Aggregator (5.4)**: chưa chạy (cần Express, `auth`, `io`); health check, scatter–gather, `/internal/events`, `reconcile` mới đúng ở mức cú pháp và logic đọc lại.
- **Docker Compose**: chưa chạy (Docker daemon tắt khi kiểm tra). Cú pháp `<<: *node` và `*pg` cần kiểm tra khi chạy; `environment` trong anchor bị ghi đè toàn bộ, không trộn.
- **Hết hạn đặt chỗ** (SQL ở 5.2) và **huỷ reservation** mới ở dạng mô tả, chưa có code đầy đủ.
- Chi tiết RabbitMQ (bản 2) mới ở mức ý tưởng.

## Liên quan
- Lý thuyết đầy đủ: `tai-lieu/ly-thuyet-ap-dung-xuyen-suot.md`
- Nguồn: Kleppmann *Distributed Systems* notes (Cambridge 2021/22); microservices.io *Transactional outbox*.
