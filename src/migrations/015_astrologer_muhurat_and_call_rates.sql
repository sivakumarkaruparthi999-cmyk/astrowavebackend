-- ==============================================================================
-- 015_astrologer_muhurat_and_call_rates.sql
-- Add is_muhurat_eligible and call_per_minute_rate to astrologer_profiles
-- ==============================================================================

ALTER TABLE astrologer_profiles ADD COLUMN IF NOT EXISTS is_muhurat_eligible BOOLEAN DEFAULT false;
ALTER TABLE astrologer_profiles ADD COLUMN IF NOT EXISTS call_per_minute_rate NUMERIC(10,2) DEFAULT 25.00;

-- Set experienced traditional astrologers as eligible for Muhurtham by default
UPDATE astrologer_profiles
SET is_muhurat_eligible = true
WHERE experience_years >= 10 OR 'Vedic' = ANY(specializations) OR 'Muhurat' = ANY(specializations);
