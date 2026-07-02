-- 0013_plan_data_provenance.sql
-- Issue #63 (Epic 6 Wave 2): plan_data_provenance + provenance/source_url/
-- ingested_at/content_hash/is_current columns.
--
-- This is the KEYSTONE schema migration for Epic 6 (#64-#69 depend on it):
--   * plans.provenance        — aligned with plans.source; backfilled from source
--   * plans.source_url        — URL the plan data was fetched from (#64/#66)
--   * plans.ingested_at       — ISO timestamp of last ingestion (#64)
--   * plans.content_hash      — hash of raw payload for idempotent upsert (#64)
--   * plans.is_current        — materialized versioning flag (#68); closes the
--                               deferred-is_current gap documented in
--                               workers/docs/infra/d1-migrations.md
--   * idx_plans_retailer_is_current — current-plan lookup index (#68)
--   * plans.source CHECK widened to allow 'powerswitch' (#65)
--   * plan_data_provenance    — audit row per fetch, column-aligned with the
--                               python/eiep14a/fetcher.py cache shape (#64/#66)
--   * bills.retailer_id       — converted to REFERENCES retailers(id)
--
-- SQLite cannot ALTER a CHECK constraint or ADD a FK in place, so both the
-- plans and bills tables are rebuilt via the temp-table swap pattern used by
-- 0006_add_web_source.sql and 0011_bill_error_code.sql. Data is preserved:
-- every old column is carried over explicitly (no SELECT *), all indexes are
-- recreated, and row counts are unchanged. See the adversarial self-verification
-- note at the bottom of this file.

-- ===========================================================================
-- 1. plans: rebuild to widen source CHECK + add new columns
-- ===========================================================================

CREATE TABLE plans_new (
    id TEXT PRIMARY KEY,
    retailer_id TEXT NOT NULL REFERENCES retailers(id),
    name TEXT NOT NULL,
    region TEXT,
    c_per_kwh REAL,
    c_per_day REAL,
    tier_thresholds_json TEXT,
    prompt_payment_discount REAL,
    conditions_json TEXT,
    low_user_eligible INTEGER NOT NULL DEFAULT 0 CHECK (low_user_eligible IN (0, 1)),
    source TEXT NOT NULL CHECK (source IN ('eiep14a', 'manual', 'powerswitch')),
    eiep14a_id TEXT,
    effective_from TEXT,
    effective_to TEXT,
    provenance TEXT CHECK (provenance IN ('eiep14a', 'powerswitch', 'manual')),
    source_url TEXT,
    ingested_at TEXT,
    content_hash TEXT,
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
);

-- Copy every existing column through; new columns default to NULL (is_current
-- defaults to 1 via the column definition above, so set it explicitly).
INSERT INTO plans_new (
    id, retailer_id, name, region, c_per_kwh, c_per_day,
    tier_thresholds_json, prompt_payment_discount, conditions_json,
    low_user_eligible, source, eiep14a_id, effective_from, effective_to,
    provenance, source_url, ingested_at, content_hash, is_current
)
SELECT
    id, retailer_id, name, region, c_per_kwh, c_per_day,
    tier_thresholds_json, prompt_payment_discount, conditions_json,
    low_user_eligible, source, eiep14a_id, effective_from, effective_to,
    NULL, NULL, NULL, NULL, 1
FROM plans;

DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;

-- Recreate indexes from 0001 (the DROP TABLE above removed them).
CREATE INDEX idx_plans_retailer_id ON plans(retailer_id);
CREATE INDEX idx_plans_region ON plans(region);
-- New index for #68 current-plan lookups.
CREATE INDEX idx_plans_retailer_is_current ON plans(retailer_id, is_current);

-- Backfill provenance from source for existing rows (source is authoritative
-- for legacy data; going forward writers set both explicitly).
UPDATE plans SET provenance = source WHERE provenance IS NULL;

-- ===========================================================================
-- 2. plan_data_provenance: audit table (column-aligned with fetcher.py cache)
-- ===========================================================================

CREATE TABLE plan_data_provenance (
    id TEXT PRIMARY KEY,
    retailer_id TEXT REFERENCES retailers(id),
    plan_id TEXT REFERENCES plans(id),
    source TEXT,
    fetched_at TEXT,
    raw_hash TEXT,
    file_url TEXT,
    record_count INTEGER,
    upserted_count INTEGER
);

-- ===========================================================================
-- 3. bills: rebuild to convert retailer_id into a REFERENCES retailers(id) FK
-- ===========================================================================
-- Current bills shape = 0001 + 0006 (source CHECK gains 'web') + 0010
-- (source_message_id) + 0011 (error_code, parsed_at, status gains 'failed')
-- + 0012 (compare_enqueued_at). All columns carried over explicitly.

CREATE TABLE bills_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    retailer_id TEXT REFERENCES retailers(id),
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
    compare_enqueued_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bills_new (
    id, user_id, retailer_id, plan_name, meter_type, period_start, period_end,
    days, usage_kwh, total_cents, c_per_kwh, c_per_day, fixed_term_expiry,
    break_fee_cents, status, confidence, raw_r2_key, parsed_json, source,
    source_message_id, error_code, parsed_at, compare_enqueued_at, created_at
)
SELECT
    id, user_id, retailer_id, plan_name, meter_type, period_start, period_end,
    days, usage_kwh, total_cents, c_per_kwh, c_per_day, fixed_term_expiry,
    break_fee_cents, status, confidence, raw_r2_key, parsed_json, source,
    source_message_id, error_code, parsed_at, compare_enqueued_at, created_at
FROM bills;

DROP TABLE bills;
ALTER TABLE bills_new RENAME TO bills;

-- Recreate indexes from 0001 (dropped with the old table).
CREATE INDEX idx_bills_user_id ON bills(user_id);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_created_at ON bills(created_at);
-- Recreate unique index from 0010.
CREATE UNIQUE INDEX idx_bills_source_message_id ON bills(source_message_id);

-- ===========================================================================
-- Down
-- ===========================================================================
-- -- Reverse bills FK rebuild (drop the FK back to a plain TEXT column).
-- CREATE TABLE bills_old (
--     id TEXT PRIMARY KEY,
--     user_id TEXT NOT NULL REFERENCES users(id),
--     retailer_id TEXT,
--     plan_name TEXT,
--     meter_type TEXT CHECK (meter_type IN ('standard', 'low_user', 'day_night', 'controlled')),
--     period_start TEXT, period_end TEXT, days INTEGER, usage_kwh REAL,
--     total_cents INTEGER, c_per_kwh REAL, c_per_day REAL, fixed_term_expiry TEXT,
--     break_fee_cents INTEGER,
--     status TEXT NOT NULL DEFAULT 'pending_parse'
--         CHECK (status IN ('pending_parse', 'parsing', 'parsed', 'needs_review', 'failed')),
--     confidence REAL, raw_r2_key TEXT, parsed_json TEXT,
--     source TEXT CHECK (source IN ('whatsapp', 'sms', 'gmail', 'outlook', 'web')),
--     source_message_id TEXT, error_code TEXT, parsed_at TEXT,
--     compare_enqueued_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
-- );
-- INSERT INTO bills_old (id, user_id, retailer_id, plan_name, meter_type,
--     period_start, period_end, days, usage_kwh, total_cents, c_per_kwh,
--     c_per_day, fixed_term_expiry, break_fee_cents, status, confidence,
--     raw_r2_key, parsed_json, source, source_message_id, error_code,
--     parsed_at, compare_enqueued_at, created_at)
-- SELECT id, user_id, retailer_id, plan_name, meter_type, period_start,
--     period_end, days, usage_kwh, total_cents, c_per_kwh, c_per_day,
--     fixed_term_expiry, break_fee_cents, status, confidence, raw_r2_key,
--     parsed_json, source, source_message_id, error_code, parsed_at,
--     compare_enqueued_at, created_at FROM bills;
-- DROP TABLE bills;
-- ALTER TABLE bills_old RENAME TO bills;
-- CREATE INDEX idx_bills_user_id ON bills(user_id);
-- CREATE INDEX idx_bills_status ON bills(status);
-- CREATE INDEX idx_bills_created_at ON bills(created_at);
-- CREATE UNIQUE INDEX idx_bills_source_message_id ON bills(source_message_id);
--
-- DROP TABLE IF EXISTS plan_data_provenance;
--
-- -- Reverse plans rebuild: drop the new columns and restore the original
-- -- (narrower) source CHECK. is_current/provenance/source_url/ingested_at/
-- -- content_hash are lost — any values written after 0013 are discarded.
-- CREATE TABLE plans_old (
--     id TEXT PRIMARY KEY,
--     retailer_id TEXT NOT NULL REFERENCES retailers(id),
--     name TEXT NOT NULL, region TEXT, c_per_kwh REAL, c_per_day REAL,
--     tier_thresholds_json TEXT, prompt_payment_discount REAL,
--     conditions_json TEXT,
--     low_user_eligible INTEGER NOT NULL DEFAULT 0 CHECK (low_user_eligible IN (0, 1)),
--     source TEXT NOT NULL CHECK (source IN ('eiep14a', 'manual')),
--     eiep14a_id TEXT, effective_from TEXT, effective_to TEXT
-- );
-- INSERT INTO plans_old (id, retailer_id, name, region, c_per_kwh, c_per_day,
--     tier_thresholds_json, prompt_payment_discount, conditions_json,
--     low_user_eligible, source, eiep14a_id, effective_from, effective_to)
-- SELECT id, retailer_id, name, region, c_per_kwh, c_per_day,
--     tier_thresholds_json, prompt_payment_discount, conditions_json,
--     low_user_eligible,
--     CASE WHEN source IN ('eiep14a', 'manual') THEN source ELSE 'manual' END,
--     eiep14a_id, effective_from, effective_to FROM plans;
-- DROP TABLE plans;
-- ALTER TABLE plans_old RENAME TO plans;
-- CREATE INDEX idx_plans_retailer_id ON plans(retailer_id);
-- CREATE INDEX idx_plans_region ON plans(region);
--
-- -- NOTE: rows whose source was set to 'powerswitch' cannot be restored
-- -- verbatim — the pre-0013 CHECK rejected that value. They are coerced to
-- -- 'manual' above. A true down-migration would also need to drop plans rows
-- -- that depended on is_current semantics (#68 not yet implemented here).

-- ===========================================================================
-- Adversarial self-verification (data preservation across the rebuilds)
-- ===========================================================================
-- plans: 14 old columns (id, retailer_id, name, region, c_per_kwh, c_per_day,
--        tier_thresholds_json, prompt_payment_discount, conditions_json,
--        low_user_eligible, source, eiep14a_id, effective_from, effective_to)
--        all present in plans_new CREATE and listed explicitly in the
--        INSERT SELECT (no SELECT *). 5 new columns appended. CHECK on source
--        now allows all three values. Indexes idx_plans_retailer_id and
--        idx_plans_region recreated; idx_plans_retailer_is_current added.
--        Backfill (provenance := source) runs AFTER the rebuild.
-- bills: 24 columns in bills_new match the union of 0001+0006+0010+0011+0012.
--        INSERT SELECT lists them explicitly. retailer_id now carries the FK.
--        All 4 bills indexes recreated (incl. the 0010 unique index).
