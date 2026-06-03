-- Migration 0006: Add 'web' to bills.source CHECK constraint
-- D1/SQLite does not support ALTER COLUMN for CHECK constraints,
-- so we rebuild the table.
-- Up
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
    status TEXT NOT NULL DEFAULT 'pending_parse' CHECK (status IN ('pending_parse', 'parsing', 'parsed', 'needs_review')),
    confidence REAL,
    raw_r2_key TEXT,
    parsed_json TEXT,
    source TEXT CHECK (source IN ('whatsapp', 'sms', 'gmail', 'outlook', 'web')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bills_new SELECT * FROM bills;

DROP TABLE bills;
ALTER TABLE bills_new RENAME TO bills;

-- Recreate indexes from 0001
CREATE INDEX idx_bills_user_id ON bills(user_id);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_created_at ON bills(created_at);
