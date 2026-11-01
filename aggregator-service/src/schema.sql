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
-- Existing minimal commands tables keep their rows and business results.
-- Missing publish metadata cannot prove whether an old PENDING command was sent:
-- quarantine it as UNKNOWN rather than automatically creating another effect.
ALTER TABLE commands ADD COLUMN IF NOT EXISTS status_code INT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS actor JSONB;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS envelope JSONB;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS reply_to TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS publish_state TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE commands ADD COLUMN IF NOT EXISTS publish_owner TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS publish_lease_until TIMESTAMPTZ;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS next_publish_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE commands ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS uncertain BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS failure_phase TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS reply_hash TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS slot JSONB;
UPDATE commands SET correlation_id=id WHERE correlation_id IS NULL;
ALTER TABLE commands ALTER COLUMN status SET DEFAULT 'PENDING';
ALTER TABLE commands ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE commands ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE commands ALTER COLUMN publish_state SET DEFAULT 'QUEUED';
ALTER TABLE commands ALTER COLUMN uncertain SET DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS commands_correlation_id_key ON commands(correlation_id);
CREATE INDEX IF NOT EXISTS ix_commands_publish ON commands(next_publish_at) WHERE status='PENDING' AND publish_state<>'CONFIRMED';
CREATE INDEX IF NOT EXISTS ix_commands_user ON commands(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS aggregator_instances (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL
);
