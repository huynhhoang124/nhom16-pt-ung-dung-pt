-- Schema của MỘT bãi. Mỗi bãi có DB riêng (shared-nothing), node khác không truy cập được.

CREATE TABLE IF NOT EXISTS parking_slots (
  id          SERIAL PRIMARY KEY,
  slot_code   VARCHAR(10) UNIQUE NOT NULL,
  floor       INT NOT NULL DEFAULT 1,
  type        VARCHAR(12) NOT NULL DEFAULT 'CAR',
  status      VARCHAR(12) NOT NULL DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE')),
  version     BIGINT NOT NULL DEFAULT 0,              -- tăng mỗi lần đổi: sắp thứ tự sự kiện, chống tin cũ/trùng
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    VARCHAR(128) UNIQUE NOT NULL,         -- "<userId>:<Idempotency-Key>": retry không tạo bản thứ hai
  user_id       VARCHAR(64) NOT NULL,
  slot_id       INT NOT NULL REFERENCES parking_slots(id),
  license_plate VARCHAR(20) NOT NULL,
  start_time    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expire_time   TIMESTAMPTZ NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','USED','CANCELLED','EXPIRED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Lưới đỡ cuối cùng ở tầng DB: mỗi slot tối đa 1 reservation ACTIVE
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_per_slot ON reservations(slot_id) WHERE status = 'ACTIVE';

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
