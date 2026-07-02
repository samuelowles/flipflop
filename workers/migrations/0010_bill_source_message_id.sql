-- Migration 0010: Add source_message_id to bills for idempotent dispatch
-- Same Sent message_id must never produce a second bill row / PARSE_QUEUE
-- enqueue. Stores the inbound Sent message id that triggered the bill and
-- unique-indexes it so a duplicate webhook redelivery is a no-op.
-- Up
ALTER TABLE bills ADD COLUMN source_message_id TEXT;
CREATE UNIQUE INDEX idx_bills_source_message_id ON bills(source_message_id);
