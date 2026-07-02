-- 0014_plan_comparisons_summary.sql
-- Issue #73 (Epic 7): convert plan_comparisons from one-row-per-candidate
-- (written by planComparator.ts pre-#73) into a single summary row per
-- comparison run carrying the recommendation verdict.
--
-- This is the only Epic 7 schema migration. All new columns are nullable so
-- SQLite's plain ALTER TABLE ADD COLUMN applies (no temp-table rebuild — that
-- pattern is only required when changing CHECK/FK constraints, as in 0006 /
-- 0011 / 0013).
--
-- New columns (AC #73):
--   * bill_id               — the bill that triggered this run (audit input)
--   * current_plan_id       — the user's plan at compare time (audit input)
--   * recommended_plan_id   — top-ranked switchable plan, or current plan when
--                             recommendation = 'stay_put' (nullable: pre-#73
--                             rows and runs with no matchable plan)
--   * projected_annual_cost — integer cents NZD, recommended plan projected
--   * savings               — integer cents NZD, signed (positive = saving)
--   * recommendation        — 'switch' | 'stay_put' (verdict for the user)
--   * reason                — RecommendationReason | NULL (set on stay_put)
--   * computed_at           — ISO 8601 timestamp the run computed the verdict
--
-- Legacy columns (plan_id, bill_ids_json, projected_cost_cents,
-- current_cost_cents, saving_cents, confidence, compared_at) are retained
-- unchanged so existing rows and any reader still relying on them keep
-- working. The new write path (post-#73) populates BOTH the legacy columns
-- (for back-compat reads) and the new summary columns.

-- ===========================================================================
-- 1. Add the AC #73 summary columns (all nullable → plain ADD COLUMN)
-- ===========================================================================

ALTER TABLE plan_comparisons ADD COLUMN bill_id TEXT REFERENCES bills(id);
ALTER TABLE plan_comparisons ADD COLUMN current_plan_id TEXT REFERENCES plans(id);
ALTER TABLE plan_comparisons ADD COLUMN recommended_plan_id TEXT REFERENCES plans(id);
ALTER TABLE plan_comparisons ADD COLUMN projected_annual_cost INTEGER;
ALTER TABLE plan_comparisons ADD COLUMN savings INTEGER;
ALTER TABLE plan_comparisons ADD COLUMN recommendation TEXT CHECK (recommendation IN ('switch', 'stay_put'));
ALTER TABLE plan_comparisons ADD COLUMN reason TEXT;
ALTER TABLE plan_comparisons ADD COLUMN computed_at TEXT;

-- ===========================================================================
-- 2. Indexes required by AC #73 (bill_id, computed_at) + the existing
--    user_id index is recreated in 0001's form only if missing. The 0001
--    schema did NOT index plan_comparisons.user_id, but AC #73 explicitly
--    requires "indexed by user_id, bill_id, computed_at". Add all three.
--    (SQLite CREATE INDEX IF NOT EXISTS keeps this idempotent.)
-- ===========================================================================

CREATE INDEX IF NOT EXISTS idx_plan_comparisons_user_id ON plan_comparisons(user_id);
CREATE INDEX IF NOT EXISTS idx_plan_comparisons_bill_id ON plan_comparisons(bill_id);
CREATE INDEX IF NOT EXISTS idx_plan_comparisons_computed_at ON plan_comparisons(computed_at);

-- ===========================================================================
-- Down
-- ===========================================================================
-- SQLite cannot ALTER TABLE DROP COLUMN prior to 3.35.0; D1's bundled
-- SQLite is newer than that, but a true down-migration would still rebuild
-- plan_comparisons without the new columns. The drop is intentionally
-- destructive (any summary rows written post-0014 lose their verdict data),
-- so it is commented out by default — do NOT run blindly.
--
-- DROP INDEX IF EXISTS idx_plan_comparisons_computed_at;
-- DROP INDEX IF EXISTS idx_plan_comparisons_bill_id;
-- DROP INDEX IF EXISTS idx_plan_comparisons_user_id;
-- -- Rebuild plan_comparisons without the 0014 columns (temp-table swap):
-- CREATE TABLE plan_comparisons_old (
--     id TEXT PRIMARY KEY,
--     user_id TEXT NOT NULL REFERENCES users(id),
--     plan_id TEXT NOT NULL REFERENCES plans(id),
--     bill_ids_json TEXT,
--     projected_cost_cents INTEGER NOT NULL,
--     current_cost_cents INTEGER NOT NULL,
--     saving_cents INTEGER NOT NULL,
--     confidence REAL NOT NULL DEFAULT 0.0,
--     compared_at TEXT NOT NULL DEFAULT (datetime('now'))
-- );
-- INSERT INTO plan_comparisons_old (id, user_id, plan_id, bill_ids_json,
--     projected_cost_cents, current_cost_cents, saving_cents, confidence,
--     compared_at)
-- SELECT id, user_id, plan_id, bill_ids_json, projected_cost_cents,
--     current_cost_cents, saving_cents, confidence, compared_at
-- FROM plan_comparisons;
-- DROP TABLE plan_comparisons;
-- ALTER TABLE plan_comparisons_old RENAME TO plan_comparisons;

-- ===========================================================================
-- Adversarial self-verification
-- ===========================================================================
-- * All 8 new columns are nullable, so ALTER TABLE ADD COLUMN is safe on a
--   table that already has rows (no NOT NULL without DEFAULT would fail).
-- * The CHECK on recommendation uses a literal IN list — allowed on
--   ADD COLUMN because it neither references other rows nor uses the
--   non-deterministic functions SQLite forbids in ALTER ADD.
-- * No temp-table rebuild → no risk of dropping idx_plan_comparisons_* or
--   losing data; the table's existing rows simply get NULL for the new
--   columns.
-- * The three IF NOT EXISTS indexes are idempotent and match the AC's
--   "indexed by user_id, bill_id, computed_at" requirement verbatim.
