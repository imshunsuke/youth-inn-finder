-- Public upstream snapshots and collection jobs contain no email or management tokens.
CREATE TABLE IF NOT EXISTS query_catalogs (
  house_type TEXT PRIMARY KEY CHECK (house_type IN ('0', '1')),
  payload_json TEXT,
  fetched_at TEXT,
  last_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS query_calendars (
  station_id TEXT PRIMARY KEY,
  payload_json TEXT,
  fetched_at TEXT,
  last_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS query_intervals (
  station_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  payload_json TEXT,
  fetched_at TEXT,
  last_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  PRIMARY KEY (station_id, start_date, end_date)
);

CREATE TABLE IF NOT EXISTS interval_query_jobs (
  station_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (station_id, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS interval_query_jobs_due
  ON interval_query_jobs (next_attempt_at, expires_at);

CREATE TABLE IF NOT EXISTS query_collector_state (
  name TEXT PRIMARY KEY,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  calendar_cursor TEXT NOT NULL DEFAULT '',
  catalog_cursor INTEGER NOT NULL DEFAULT 0,
  reminder_cursor TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
