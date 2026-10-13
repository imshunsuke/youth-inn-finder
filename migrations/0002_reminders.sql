-- D1 / SQLite. Tokens are SHA-256 digests; outbox payloads use authenticated
-- encryption with APP_SECRET and are erased when sent, invalidated or expired.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','paused','cancelled','expired')),
  condition_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  last_checked_at TEXT,
  next_check_at TEXT,
  last_match INTEGER CHECK(last_match IS NULL OR last_match IN (0,1)),
  match_cycle INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, next_check_at);
CREATE INDEX IF NOT EXISTS reminders_email ON reminders(email, status);
CREATE TABLE IF NOT EXISTS reminder_tokens (
  digest TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify','manage')),
  email TEXT NOT NULL,
  reminder_id TEXT,
  condition_version INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS reminder_tokens_expiry ON reminder_tokens(expires_at);
CREATE TABLE IF NOT EXISTS reminder_outbox (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('verify','access','notification')),
  reminder_id TEXT,
  condition_version INTEGER,
  recipient_email TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  payload_ciphertext TEXT,
  observed_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','dead','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until TEXT,
  sent_at TEXT,
  last_error_code TEXT
);
CREATE INDEX IF NOT EXISTS reminder_outbox_due ON reminder_outbox(status, available_at);
CREATE TABLE IF NOT EXISTS reminder_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminder_rate_expiry ON reminder_rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS reminder_mail_budgets (
  budget_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
