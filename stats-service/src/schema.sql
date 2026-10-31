CREATE TABLE IF NOT EXISTS stats_hourly (
    hour TIMESTAMPTZ NOT NULL,
    parking_id TEXT NOT NULL,
    zone TEXT NOT NULL DEFAULT 'default',
    entries INTEGER NOT NULL DEFAULT 0,
    exits INTEGER NOT NULL DEFAULT 0,
    revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, parking_id, zone)
);

CREATE TABLE IF NOT EXISTS stats_processed_events (
    event_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stats_consumer_offsets (
    consumer_name TEXT PRIMARY KEY,
    stream_name TEXT NOT NULL,
    last_offset BIGINT NOT NULL DEFAULT -1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stats_hourly_parking_hour
    ON stats_hourly (parking_id, hour);


-- Lưu phiên gửi xe để tính thời gian trung bình.
CREATE TABLE IF NOT EXISTS stats_sessions (
    session_id TEXT PRIMARY KEY,
    parking_id TEXT NOT NULL,
    entered_at TIMESTAMPTZ,
    exited_at TIMESTAMPTZ,
    fee NUMERIC(14, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stats_sessions_parking_entered
    ON stats_sessions (parking_id, entered_at);

-- Lưu trạng thái sức chứa mới nhất của từng bãi.
CREATE TABLE IF NOT EXISTS stats_parking_state (
    parking_id TEXT PRIMARY KEY,
    available INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
