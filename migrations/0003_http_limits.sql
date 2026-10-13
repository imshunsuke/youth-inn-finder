CREATE TABLE IF NOT EXISTS http_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS http_rate_limits_expiry ON http_rate_limits(expires_at);
