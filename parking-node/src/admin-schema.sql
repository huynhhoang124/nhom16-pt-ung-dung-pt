CREATE TABLE IF NOT EXISTS admin_command_gate (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO admin_command_gate(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS admin_floor_locks (
  floor INTEGER PRIMARY KEY,
  locked BOOLEAN NOT NULL,
  command_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Track only slots changed by this feature: unlocking must not clear a manual maintenance state.
CREATE TABLE IF NOT EXISTS admin_locked_slots (
  slot_id INTEGER PRIMARY KEY REFERENCES parking_slots(id),
  floor INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS banned_plates (
  license_plate TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
