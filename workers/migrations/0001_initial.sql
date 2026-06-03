-- Up
-- Flip Phase 1: Initial schema
-- All 9 tables for core infrastructure

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    sent_contact_id TEXT,
    name TEXT,
    email TEXT,
    subscription_tier TEXT NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'paid')),
    stripe_customer_id TEXT,
    current_retailer_id TEXT,
    current_plan_name TEXT,
    icp_number TEXT,
    installation_address TEXT,
    notification_threshold_cents INTEGER NOT NULL DEFAULT 5000,
    state TEXT NOT NULL DEFAULT 'NEW' CHECK (state IN ('NEW', 'ONBOARDING', 'ACTIVE', 'AWAITING_BILL', 'AWAITING_SWITCH_CONFIRM', 'SWITCHING', 'INACTIVE', 'UNSUBSCRIBED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bills (
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
    source TEXT CHECK (source IN ('whatsapp', 'sms', 'gmail', 'outlook')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE retailers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT,
    parser_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE plans (
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
    source TEXT NOT NULL CHECK (source IN ('eiep14a', 'manual')),
    eiep14a_id TEXT,
    effective_from TEXT,
    effective_to TEXT
);

CREATE TABLE plan_comparisons (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    plan_id TEXT NOT NULL REFERENCES plans(id),
    bill_ids_json TEXT,
    projected_cost_cents INTEGER NOT NULL,
    current_cost_cents INTEGER NOT NULL,
    saving_cents INTEGER NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.0,
    compared_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE switches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    from_retailer_id TEXT NOT NULL REFERENCES retailers(id),
    to_plan_id TEXT NOT NULL REFERENCES plans(id),
    status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'in_progress', 'completed', 'failed')),
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at TEXT,
    completed_at TEXT
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
    body TEXT,
    media_url TEXT,
    sent_message_id TEXT,
    intent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    expiry TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('saving_alert', 'stay_put', 'fixed_term_expiry', 'free_tier_checkin', 'switch_update')),
    content_json TEXT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at TEXT,
    response TEXT
);

-- Indexes
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_state ON users(state);
CREATE INDEX idx_bills_user_id ON bills(user_id);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_created_at ON bills(created_at);
CREATE INDEX idx_plans_retailer_id ON plans(retailer_id);
CREATE INDEX idx_plans_region ON plans(region);
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_switches_user_id ON switches(user_id);
CREATE INDEX idx_comparisons_user_id ON plan_comparisons(user_id);

-- Down
-- DROP TABLE IF EXISTS notifications;
-- DROP TABLE IF EXISTS oauth_tokens;
-- DROP TABLE IF EXISTS messages;
-- DROP TABLE IF EXISTS switches;
-- DROP TABLE IF EXISTS plan_comparisons;
-- DROP TABLE IF EXISTS plans;
-- DROP TABLE IF EXISTS retailers;
-- DROP TABLE IF EXISTS bills;
-- DROP TABLE IF EXISTS users;
