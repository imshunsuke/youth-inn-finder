ALTER TABLE query_collector_state ADD COLUMN interactive_started_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_collector_state ADD COLUMN interactive_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_collector_state ADD COLUMN interactive_requests INTEGER NOT NULL DEFAULT 0;
