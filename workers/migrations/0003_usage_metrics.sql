-- Up
-- Flip Phase 2: Usage metrics table for tracking user consumption patterns
-- Stores computed averages, seasonal baselines, anomalies, and year-over-year comparisons

CREATE TABLE IF NOT EXISTS usage_metrics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  metric_type TEXT NOT NULL CHECK(metric_type IN ('monthly_avg', 'seasonal_baseline', 'anomaly', 'yoy_comparison')),
  period_start TEXT,
  period_end TEXT,
  metric_json TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_usage_metrics_user ON usage_metrics(user_id, metric_type);

-- Down
-- DROP TABLE IF EXISTS usage_metrics;
