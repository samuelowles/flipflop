-- 0011_bill_error_code.sql
-- Issue #39: PARSE_QUEUE consumer retry/DLQ + failed/error_code support.
--
-- Adds:
--   bills.error_code  TEXT          — short no-PII code (e.g. 'python_5xx', 'extract_failed')
--   bills.parsed_at   TEXT          — ISO timestamp marking when parse completed
-- Relaxes the status CHECK to allow 'failed' (terminal parse failure).
--
-- SQLite cannot ALTER a CHECK constraint in place, so we rebuild the bills
-- table. Data is preserved via the temp-table swap pattern. The source table
-- already matches the 0001 + 0010 (source_message_id) + this migration's
-- columns, so we copy all columns through.

-- 1. Create the new table with the relaxed constraint + new columns.
CREATE TABLE bills_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    retailer_id TEXT,
    plan_name TEXT,
    meter_type TEXT CHECK (meter_type IN ('standard', 'low_user', 'day_night', 'controlled')),
    period_start TEXT,
    period_end TEXT,
    days INTEGER,
    usage_kwh REAL,
    total_cents INTEGER,
    c_per_kwh REAL,
    c_per_day REAL,
    fixed_term_expiry TEXT,
    break_fee_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'pending_parse'
        CHECK (status IN ('pending_parse', 'parsing', 'parsed', 'needs_review', 'failed')),
    confidence REAL,
    raw_r2_key TEXT,
    parsed_json TEXT,
    source TEXT CHECK (source IN ('whatsapp', 'sms', 'gmail', 'outlook', 'web')),
    source_message_id TEXT,
    error_code TEXT,
    parsed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Copy existing rows; new columns default to NULL.
INSERT INTO bills_new (
    id, user_id, retailer_id, plan_name, meter_type, period_start, period_end,
    days, usage_kwh, total_cents, c_per_kwh, c_per_day, fixed_term_expiry,
    break_fee_cents, status, confidence, raw_r2_key, parsed_json, source,
    source_message_id, error_code, parsed_at, created_at
)
SELECT
    id, user_id, retailer_id, plan_name, meter_type, period_start, period_end,
    days, usage_kwh, total_cents, c_per_kwh, c_per_day, fixed_term_expiry,
    break_fee_cents, status, confidence, raw_r2_key, parsed_json, source,
    source_message_id, NULL, NULL, created_at
FROM bills;

-- 3. Swap.
DROP TABLE bills;
ALTER TABLE bills_new RENAME TO bills;
