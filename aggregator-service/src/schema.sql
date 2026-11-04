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

-- PD-21: token bucket đăng nhập sai, nằm cùng phân mảnh với users -> mọi bản Aggregator dùng chung giới hạn
CREATE TABLE IF NOT EXISTS login_buckets (
  username   TEXT PRIMARY KEY,
  tokens     REAL NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UX-01: toạ độ để hiện bản đồ, tìm bãi gần nhất
ALTER TABLE parking_nodes ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE parking_nodes ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
-- PT-05: địa chỉ node mà TRÌNH DUYỆT nhân viên gọi thẳng được khi Aggregator sập (khác api_url trong mạng nội bộ)
ALTER TABLE parking_nodes ADD COLUMN IF NOT EXISTS public_url TEXT;
ALTER TABLE parking_nodes ADD COLUMN IF NOT EXISTS zone TEXT NOT NULL DEFAULT 'bac';
ALTER TABLE parking_nodes ALTER COLUMN zone SET DEFAULT 'bac';
UPDATE parking_nodes SET zone = 'bac' WHERE zone IS NULL;

-- PT-07: nhật ký saga đặt chỗ nhiều bãi (ghi sau mỗi bước để khôi phục khi Aggregator chết giữa chừng)
CREATE TABLE IF NOT EXISTS sagas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id VARCHAR(128) UNIQUE NOT NULL,     -- userId:Idempotency-Key
  user_id    TEXT NOT NULL,
  status     VARCHAR(14) NOT NULL CHECK (status IN ('PENDING','RUNNING','CONFIRMING','COMPLETED','COMPENSATING','FAILED')),
  steps      JSONB NOT NULL,                   -- [{parkingId, slotCode, licensePlate, state, reservationId?, error?}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- DB cũ cần nhận trạng thái mới khi khởi động lại.
ALTER TABLE sagas DROP CONSTRAINT IF EXISTS sagas_status_check;
ALTER TABLE sagas ADD CONSTRAINT sagas_status_check
  CHECK (status IN ('PENDING','RUNNING','CONFIRMING','COMPLETED','COMPENSATING','FAILED'));

-- PD-03: shared durable command identity and recoverable publish intent.
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  parking_id TEXT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','FAILED','EXPIRED')),
  result JSONB,
  status_code INT,
  request_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  actor JSONB NOT NULL,
  envelope JSONB NOT NULL,
  correlation_id TEXT UNIQUE NOT NULL,
  reply_to TEXT NOT NULL,
  publish_state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(publish_state IN ('QUEUED','SENDING','CONFIRMED','UNKNOWN','REJECTED')),
  publish_owner TEXT,
  publish_lease_until TIMESTAMPTZ,
  next_publish_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  uncertain BOOLEAN NOT NULL DEFAULT false,
  failure_phase TEXT,
  last_error TEXT,
  reply_hash TEXT,
  slot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_commands_publish ON commands(next_publish_at) WHERE status='PENDING' AND publish_state<>'CONFIRMED';
CREATE INDEX IF NOT EXISTS ix_commands_user ON commands(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS aggregator_instances (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL
);

-- PD-08: additive migration, source bytes/properties never returned directly by the API.
CREATE TABLE IF NOT EXISTS dead_letters (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT UNIQUE NOT NULL,
  message_id TEXT,
  content_base64 TEXT NOT NULL,
  properties JSONB NOT NULL,
  routing_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','PUBLISHING','BROKER_CONFIRMED','REPLAY_EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replay_message_id TEXT,
  replay_body JSONB,
  replay_properties JSONB,
  replay_admin TEXT,
  replay_requested_at TIMESTAMPTZ,
  replayed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_dead_letters_pending ON dead_letters(id) WHERE status='PUBLISHING';
