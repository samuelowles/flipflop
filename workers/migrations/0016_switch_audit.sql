-- 0016_switch_audit.sql
-- Issue #129 (Epic #8): switch state-machine transition log + failure_reason.
--
-- Two changes:
--   1. NEW table `switch_transitions` — one row per state change on `switches`,
--      carrying from_status / to_status / actor / reason / at. AC #129:
--      "All transitions logged with request_id, from, to, by". (`request_id`
--      in the AC maps to `switch_id` here — a switch request's PK.)
--   2. ALTER `switches` ADD COLUMN failure_reason — captured when a switch
--      transitions to `failed`. This column is OWNED by #129 but CONSUMED
--      later by issue #132 (email fallback), so #132 needs no migration of
--      its own. Nullable: every pre-existing row has no failure_reason.
--
-- ENUM NOTE: the issue title says `initiated -> confirmed -> completed | failed`,
-- but the EXISTING CHECK on switches.status (0001) uses `requested` (not
-- `initiated`). `requested` is treated as the "initiated" start state. We do
-- NOT change the CHECK constraint here (that would require a temp-table
-- rebuild migration — out of scope for #129). The to_status / from_status
-- columns below deliberately have NO CHECK so they can record any historical
-- value without breaking the log if the enum ever evolves.
--
-- AC #129 columns on switch_transitions:
--   * switch_id    — FK→switches ON DELETE CASCADE (log dies with its parent)
--   * from_status  — TEXT, nullable (null on the initial creation row only)
--   * to_status    — TEXT NOT NULL (the new state)
--   * actor        — who/what triggered it: system | user | webhook | cron
--   * reason       — free-text context (nullable; e.g. "user confirmed",
--                    "retailer rejected", "manual retry")
--   * at           — ISO 8601 timestamp the transition was recorded

CREATE TABLE IF NOT EXISTS switch_transitions (
    id TEXT PRIMARY KEY,
    switch_id TEXT NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('system', 'user', 'webhook', 'cron')),
    reason TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index the per-switch history path (list transitions for one switch).
CREATE INDEX IF NOT EXISTS idx_switch_transitions_switch_id ON switch_transitions(switch_id);

-- failure_reason for #132 (email fallback). Nullable: only set on `failed`.
ALTER TABLE switches ADD COLUMN failure_reason TEXT;

-- ===========================================================================
-- Down
-- ===========================================================================
-- SQLite cannot easily drop a column without a temp-table rebuild, so the
-- ALTER is intentionally one-way within this migration's lifetime. The new
-- table + index are idempotent and safe to re-apply.
-- DROP INDEX IF EXISTS idx_switch_transitions_switch_id;
-- DROP TABLE IF EXISTS switch_transitions;

-- ===========================================================================
-- Adversarial self-verification
-- ===========================================================================
-- * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS → idempotent,
--   matches 0009/0015 pattern.
-- * switch_id is NOT NULL with ON DELETE CASCADE — a deleted switch takes its
--   audit log with it (no orphan rows). Matches AC #129 intent (log belongs
--   to the switch lifecycle).
-- * from_status is nullable: the very first transition row (creation) has no
--   "from" state. to_status is NOT NULL — every transition has a target.
-- * actor has a CHECK (closed set); from_status/to_status deliberately do
--   NOT, so the log survives any future enum evolution without a rebuild.
-- * ALTER TABLE ADD COLUMN is the idiomatic D1 pattern (0006/0011 precedent);
--   added column is nullable so existing rows are unaffected.
-- * `at` uses datetime('now') default — identical to every other timestamp
--   column in the schema.
