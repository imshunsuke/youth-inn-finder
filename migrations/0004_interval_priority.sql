-- Active verified reminders have bounded priority independent of public query TTL.
ALTER TABLE interval_query_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0
  CHECK (priority IN (0, 1));
ALTER TABLE interval_query_jobs ADD COLUMN priority_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS interval_query_jobs_priority_due
  ON interval_query_jobs (priority DESC, next_attempt_at, expires_at);
