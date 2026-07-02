-- 0012_bill_compare_enqueued.sql
-- Issue #43: idempotent COMPARE_QUEUE enqueue on parse success.
--
-- Adds bills.compare_enqueued_at TEXT — ISO timestamp set atomically the first
-- time a parsed bill is enqueued for comparison. The parse handler does a
-- conditional UPDATE (WHERE compare_enqueued_at IS NULL); if zero rows are
-- updated the enqueue is skipped, so a duplicate PARSE_QUEUE redelivery cannot
-- produce a second COMPARE_QUEUE message for the same bill.
--
-- Matches the existing idempotency pattern: 0010 unique-indexes
-- source_message_id so a duplicate webhook is a no-op. Here a nullable timestamp
-- + conditional UPDATE is sufficient (a unique index is not needed because the
-- guard is the atomicity of the conditional write, not a uniqueness constraint).

-- Up
ALTER TABLE bills ADD COLUMN compare_enqueued_at TEXT;
