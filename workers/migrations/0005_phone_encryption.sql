-- Up
-- Flip: Phone encryption + message body encryption
-- Adds blind index (phone_hash) for lookup, encrypted phone column, and encrypted message body.

ALTER TABLE users ADD COLUMN phone_encrypted TEXT;
ALTER TABLE users ADD COLUMN phone_hash TEXT;

ALTER TABLE messages ADD COLUMN body_encrypted TEXT;

CREATE INDEX idx_users_phone_hash ON users(phone_hash);

-- Down
-- ALTER TABLE users DROP COLUMN phone_encrypted;
-- ALTER TABLE users DROP COLUMN phone_hash;
-- ALTER TABLE messages DROP COLUMN body_encrypted;
-- DROP INDEX IF EXISTS idx_users_phone_hash;
