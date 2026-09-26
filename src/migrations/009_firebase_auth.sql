-- ==============================================================================
-- 009_firebase_auth.sql - Firebase Authentication Schema Updates
-- Adds support for Firebase UID identity mapping, provider tracking,
-- and passwordless authentication for customers.
-- ==============================================================================

-- Add firebase_uid for fast mapping of Firebase Auth identity to internal user UUID
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) UNIQUE;

-- Track primary authentication provider (e.g. 'phone', 'google', 'password')
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'password';

-- Track last login timestamp
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Allow passwordless authentication (Phone SMS OTP / Google Auth)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Index firebase_uid for performant token resolution in middleware
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
