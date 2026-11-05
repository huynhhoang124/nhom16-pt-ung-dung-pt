CREATE TABLE IF NOT EXISTS admin_broadcasts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  zone TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  envelope JSONB NOT NULL,
  targets JSONB NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  publish_state TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (publish_state IN ('QUEUED','SENDING','CONFIRMED','UNKNOWN','REJECTED')),
  lease_until TIMESTAMPTZ,
  lease_owner TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_broadcast_publish ON admin_broadcasts(created_at)
  WHERE publish_state IN ('QUEUED','SENDING','UNKNOWN');
CREATE TABLE IF NOT EXISTS admin_broadcast_results (
  broadcast_id TEXT NOT NULL REFERENCES admin_broadcasts(id),
  parking_id TEXT NOT NULL,
  status_code INTEGER NOT NULL CHECK(status_code BETWEEN 200 AND 599),
  result JSONB NOT NULL,
  reply_hash TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(broadcast_id,parking_id)
);
