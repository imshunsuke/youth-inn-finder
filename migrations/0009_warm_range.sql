-- One public, anonymous recently requested range. No email or management token.
-- Warming uses spare slots inside the existing collector request budget.
CREATE TABLE query_warm_ranges (
  name TEXT PRIMARY KEY CHECK (name = 'popular'),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  house_type TEXT NOT NULL CHECK (house_type IN ('0', '1')),
  only_on_shelf INTEGER NOT NULL CHECK (only_on_shelf IN (0, 1)),
  expires_at INTEGER NOT NULL
);
