-- Indexed last-service lookup for fair range scheduling; snapshots stay intact.
CREATE INDEX IF NOT EXISTS query_intervals_range_attempt
  ON query_intervals (start_date, end_date, last_attempt_at);
