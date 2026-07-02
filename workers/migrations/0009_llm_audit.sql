-- Up
-- Flip #36: LLM audit logging with 30-day retention.
-- Persists METADATA ONLY (model, intent, confidence, latency, prompt_version).
-- Deliberately stores NO message body, prompt text, response text, or PII —
-- the 30-day purge runs against these metadata rows (the "prompt+response
-- pairs" referenced in the AC are represented here by their metadata record).

CREATE TABLE IF NOT EXISTS llm_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  model TEXT NOT NULL,
  intent TEXT,
  confidence REAL,
  latency_ms INTEGER,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_llm_audit_created_at ON llm_audit(created_at);

-- Down
-- DROP INDEX IF EXISTS idx_llm_audit_created_at;
-- DROP TABLE IF EXISTS llm_audit;
