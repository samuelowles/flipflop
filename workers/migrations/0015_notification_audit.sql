-- 0015_notification_audit.sql
-- Issue #82 (Epic #8): compliance audit log for every notification outcome.
--
-- This is a SEPARATE table from the `notifications` table in 0001 (which
-- tracks user RESPONSES to notifications: responded_at, response). #82 needs
-- a compliance audit trail: one row per notification outcome (sent,
-- suppressed, or failed) for every channel (WhatsApp/SMS/email), carrying the
-- Sent template + provider message id so ops can answer "who was notified
-- about what, when, and did it land?"
--
-- AC #82 columns:
--   * user_id            — FK→users (always set; every audit row belongs to a user)
--   * notification_type  — the PRD notification enum (mirrors `notifications.type`)
--   * comparison_id      — FK→plan_comparisons (nullable: switch_update /
--                          fixed_term_expiry audits may have no comparison)
--   * channel            — whatsapp | sms | email (the delivery channel used)
--   * template           — the Sent template name/id that was sent (nullable
--                          only on `failed` rows where no template resolved)
--   * sent_message_id    — the provider's message id (nullable until the
--                          provider acknowledges; `failed` rows never set it)
--   * status             — sent | suppressed | failed
--   * reason             — free-text: suppression reason OR failure error
--                          (nullable on clean `sent` rows)
--   * created_at         — ISO 8601 timestamp the outcome was recorded
--
-- 90-day retention: purged daily by the purgeNotificationAudit cron (see
-- models/notificationAudit.ts + index.ts scheduled()). The 03:00 UTC slot
-- already runs the LLM-audit purge; #82 reuses that slot to keep the cron
-- list from growing.

CREATE TABLE IF NOT EXISTS notification_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    notification_type TEXT NOT NULL CHECK (notification_type IN (
        'saving_alert', 'stay_put', 'fixed_term_expiry',
        'free_tier_checkin', 'switch_update'
    )),
    comparison_id TEXT REFERENCES plan_comparisons(id),
    channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
    template TEXT,
    sent_message_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('sent', 'suppressed', 'failed')),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AC #82: admin history surfaced by user + date range; also index the purge
-- path (DELETE ... WHERE created_at < ...).
CREATE INDEX IF NOT EXISTS idx_notification_audit_user_id ON notification_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_audit_created_at ON notification_audit(created_at);
-- Filter by status is common (ops wants "show me all failures") — index it.
CREATE INDEX IF NOT EXISTS idx_notification_audit_status ON notification_audit(status);

-- ===========================================================================
-- Down
-- ===========================================================================
-- DROP INDEX IF EXISTS idx_notification_audit_status;
-- DROP INDEX IF EXISTS idx_notification_audit_created_at;
-- DROP INDEX IF EXISTS idx_notification_audit_user_id;
-- DROP TABLE IF EXISTS notification_audit;

-- ===========================================================================
-- Adversarial self-verification
-- ===========================================================================
-- * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS → idempotent if
--   re-applied (matches 0009_llm_audit.sql pattern).
-- * CHECK constraints use literal IN lists, matching 0001 style.
-- * user_id is NOT NULL (every audit row belongs to a user); comparison_id is
--   nullable per AC (not every notification originates from a comparison).
-- * template is nullable: a `failed` row may have no resolved template yet
--   (e.g. template registry miss). sent_message_id is nullable until the
--   provider acks. reason is nullable on clean `sent` rows.
-- * No temp-table rebuild — this is a brand-new table, no data to preserve.
-- * created_at uses datetime('now') default, identical to every other table.
