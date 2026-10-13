ALTER TABLE query_collector_state ADD COLUMN interactive_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_collector_state ADD COLUMN collection_wait_until INTEGER NOT NULL DEFAULT 0;
