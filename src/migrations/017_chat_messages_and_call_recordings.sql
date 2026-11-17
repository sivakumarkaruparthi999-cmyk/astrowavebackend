-- 017_chat_messages_and_call_recordings.sql
-- Authoritative persistent storage for chat messages, call recordings, and sessions in PostgreSQL

-- 1. Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES users(id) ON DELETE SET NULL,
    sender_role VARCHAR(50) NOT NULL DEFAULT 'customer',
    message_type VARCHAR(50) NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    media_url TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'sent',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_consultation ON chat_messages(consultation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);

-- 2. Call Recordings Table & Column on Consultations
ALTER TABLE consultations ADD COLUMN IF NOT EXISTS recording_url TEXT;

CREATE TABLE IF NOT EXISTS call_recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    caller_id UUID REFERENCES users(id) ON DELETE SET NULL,
    receiver_id UUID REFERENCES users(id) ON DELETE SET NULL,
    recording_url TEXT NOT NULL,
    file_name VARCHAR(255),
    file_size BIGINT DEFAULT 0,
    duration_seconds INT DEFAULT 0,
    call_type VARCHAR(50) DEFAULT 'voice',
    mime_type VARCHAR(100) DEFAULT 'audio/webm',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_recordings_consultation ON call_recordings(consultation_id);

-- 3. Call Sessions Table
CREATE TABLE IF NOT EXISTS call_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(100),
    consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    astrologer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'voice',
    status VARCHAR(50) NOT NULL DEFAULT 'initiating',
    duration_seconds INT NOT NULL DEFAULT 0,
    recording_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_consultation ON call_sessions(consultation_id);
