-- 018_astrologer_verification_applications.sql
-- Comprehensive Astrologer / Vendor Verification and Onboarding System

CREATE TABLE IF NOT EXISTS astrologer_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id VARCHAR(50) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255) NOT NULL,
    profile_photo TEXT NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    skills TEXT[] NOT NULL DEFAULT '{}',
    other_skill VARCHAR(255),
    languages TEXT[] NOT NULL DEFAULT '{}',
    other_language VARCHAR(255),
    years_of_experience NUMERIC(5,1) NOT NULL DEFAULT 0,
    bio TEXT NOT NULL DEFAULT '',
    specializations VARCHAR(255),
    consultation_experience TEXT,
    location VARCHAR(255),
    intro_video TEXT,
    certificates TEXT[] DEFAULT '{}',
    documents TEXT[] DEFAULT '{}',
    status VARCHAR(50) NOT NULL DEFAULT 'SUBMITTED', -- 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_astrologer_applications_status ON astrologer_applications(status);
CREATE INDEX IF NOT EXISTS idx_astrologer_applications_email ON astrologer_applications(email);
CREATE INDEX IF NOT EXISTS idx_astrologer_applications_phone ON astrologer_applications(phone);
CREATE INDEX IF NOT EXISTS idx_astrologer_applications_created ON astrologer_applications(created_at DESC);

CREATE TABLE IF NOT EXISTS astrologer_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES astrologer_applications(id) ON DELETE CASCADE,
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_history_application ON astrologer_status_history(application_id, created_at DESC);
