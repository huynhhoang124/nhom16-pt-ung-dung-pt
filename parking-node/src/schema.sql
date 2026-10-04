-- Schema của MỘT bãi. Mỗi bãi có DB riêng (shared-nothing), node khác không truy cập được.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- cho ràng buộc EXCLUDE (slot_id WITH =, khoảng thời gian WITH &&)

CREATE TABLE IF NOT EXISTS parking_slots (
  id          SERIAL PRIMARY KEY,
  slot_code   VARCHAR(10) UNIQUE NOT NULL,
  floor       INT NOT NULL DEFAULT 1,
  type        VARCHAR(12) NOT NULL DEFAULT 'CAR' CHECK (type IN ('CAR','MOTO')),
  status      VARCHAR(12) NOT NULL DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','HIDDEN')),   -- HIDDEN = đã gỡ (xoá mềm)
  version     BIGINT NOT NULL DEFAULT 0,              -- tăng mỗi lần đổi: sắp thứ tự sự kiện, chống tin cũ/trùng
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    VARCHAR(128) UNIQUE NOT NULL,         -- "<userId>:<Idempotency-Key>": retry không tạo bản thứ hai
  user_id       VARCHAR(64) NOT NULL,
  slot_id       INT NOT NULL REFERENCES parking_slots(id),
  license_plate VARCHAR(20) NOT NULL,
  start_time    TIMESTAMPTZ NOT NULL DEFAULT now(),   -- giờ đến
  end_time      TIMESTAMPTZ NOT NULL,                 -- hết khung giờ đã đặt (NV-01)
  expire_time   TIMESTAMPTZ NOT NULL,                 -- quá giờ này chưa đến = no-show
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','USED','DONE','CANCELLED','EXPIRED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  -- Lưới đỡ ở tầng DB: trên cùng một slot, các lượt đặt còn hiệu lực không được chồng giờ.
  -- Thay cho "mỗi slot 1 reservation ACTIVE" của bản cơ bản. DB cũ cần docker compose down -v.
  CONSTRAINT ex_no_overlap EXCLUDE USING gist
    (slot_id WITH =, tstzrange(start_time, end_time) WITH &&) WHERE (status IN ('ACTIVE','USED'))
);

-- Vừa là lịch sử sự kiện, vừa là OUTBOX: ghi cùng giao dịch với dữ liệu, relay gửi lên broker sau
CREATE TABLE IF NOT EXISTS parking_events (
  id            BIGSERIAL PRIMARY KEY,
  event_type    VARCHAR(20) NOT NULL,
  slot_code     VARCHAR(10) NOT NULL,
  license_plate VARCHAR(20),
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_events_unpublished ON parking_events(id) WHERE published_at IS NULL;

-- Phiên gửi xe: mở khi xe vào, đóng khi xe ra (lịch sử, tính phí, thanh toán).
CREATE TABLE IF NOT EXISTS parking_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id        INT NOT NULL REFERENCES parking_slots(id),
  license_plate  VARCHAR(20),                         -- NULL khi barrier không đọc được biển số và không có đặt chỗ
  reservation_id UUID REFERENCES reservations(id),
  user_id        VARCHAR(64),                         -- có khi xe vào bằng đặt chỗ
  entered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at      TIMESTAMPTZ,
  fee            INT,                                 -- VND, tính khi xe ra
  paid_at        TIMESTAMPTZ,
  payment_method VARCHAR(8),                          -- ONLINE | CASH
  payment_key    VARCHAR(128) UNIQUE                  -- Idempotency-Key của lần thanh toán
);
-- Mỗi slot tối đa 1 phiên đang mở; mỗi biển số tối đa 1 phiên đang mở TRONG BÃI NÀY
-- (chặn trên toàn hệ thống cần phối hợp nhiều bãi -> chọn sẵn sàng, phát hiện bằng tra cứu gom).
CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session_slot  ON parking_sessions(slot_id)       WHERE exited_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session_plate ON parking_sessions(license_plate) WHERE exited_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_sessions_entered ON parking_sessions(entered_at DESC);

-- Bảng giá của RIÊNG bãi này (mỗi bãi tự đặt giá, đổi giá bãi C không ảnh hưởng A, B). Tiền là số nguyên VND.
CREATE TABLE IF NOT EXISTS pricing_rules (
  vehicle_type    VARCHAR(12) PRIMARY KEY CHECK (vehicle_type IN ('CAR','MOTO')),
  first_block_min INT NOT NULL,
  first_block_fee INT NOT NULL,
  next_hour_fee   INT NOT NULL,
  overnight_fee   INT NOT NULL,
  max_day_fee     INT
);
