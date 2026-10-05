-- DB điều phối: chỉ metadata các bãi và tài khoản. KHÔNG chứa dữ liệu slot (nguồn gốc ở DB từng bãi).

CREATE TABLE IF NOT EXISTS parking_nodes (
  parking_id VARCHAR(8) PRIMARY KEY,
  name       TEXT NOT NULL,
  api_url    TEXT NOT NULL,
  address    TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(8) NOT NULL CHECK (role IN ('USER','STAFF','ADMIN')),
  parking_id    VARCHAR(8)                              -- STAFF chỉ thao tác được bãi của mình
);

-- UX-01: toạ độ để hiện bản đồ, tìm bãi gần nhất
ALTER TABLE parking_nodes ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE parking_nodes ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
-- PT-05: địa chỉ node mà TRÌNH DUYỆT nhân viên gọi thẳng được khi Aggregator sập (khác api_url trong mạng nội bộ)
ALTER TABLE parking_nodes ADD COLUMN IF NOT EXISTS public_url TEXT;

-- PT-07: nhật ký saga đặt chỗ nhiều bãi (ghi sau mỗi bước để khôi phục khi Aggregator chết giữa chừng)
CREATE TABLE IF NOT EXISTS sagas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id VARCHAR(128) UNIQUE NOT NULL,     -- userId:Idempotency-Key
  user_id    TEXT NOT NULL,
  status     VARCHAR(14) NOT NULL CHECK (status IN ('RUNNING','COMPLETED','COMPENSATING','FAILED')),
  steps      JSONB NOT NULL,                   -- [{parkingId, slotCode, licensePlate, state, reservationId?, error?}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
