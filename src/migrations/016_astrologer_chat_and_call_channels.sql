-- Migration 016: Astrologer Chat & Call Channel Controls
-- Allows Admin and Astrologer to determine whether an astrologer offers Chat, Call, or Both.

ALTER TABLE astrologer_profiles ADD COLUMN IF NOT EXISTS is_chat_enabled BOOLEAN DEFAULT true;
ALTER TABLE astrologer_profiles ADD COLUMN IF NOT EXISTS is_call_enabled BOOLEAN DEFAULT true;

-- Ensure existing records have default true
UPDATE astrologer_profiles SET is_chat_enabled = true WHERE is_chat_enabled IS NULL;
UPDATE astrologer_profiles SET is_call_enabled = true WHERE is_call_enabled IS NULL;
