-- ==============================================================================
-- 001_schema.sql - AstroTalk Central PostgreSQL 18 Schema
-- Relational source of truth for users, profiles, astrologers, pandits,
-- pooja rituals, muhurat, wallets, ledgers, payouts, commissions, and reviews.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- User Roles and Statuses
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM (
            'customer', 'astrologer', 'pandit', 'vendor', 'support', 'finance', 'admin', 'super_admin'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
        CREATE TYPE user_status AS ENUM ('active', 'blocked', 'suspended', 'deleted');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_status') THEN
        CREATE TYPE verification_status AS ENUM ('pending', 'approved', 'rejected', 'resubmit');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consultation_state') THEN
        CREATE TYPE consultation_state AS ENUM (
            'REQUESTED', 'ACCEPTED', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED', 'EXPIRED', 'REFUNDED'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pooja_booking_state') THEN
        CREATE TYPE pooja_booking_state AS ENUM (
            'REQUESTED', 'PAYMENT_PENDING', 'PAID', 'ASSIGNED', 'ACCEPTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'REFUND_REQUESTED', 'REFUNDED', 'REJECTED'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
        CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded', 'partially_refunded');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_request_status') THEN
        CREATE TYPE payout_request_status AS ENUM (
            'REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_type') THEN
        CREATE TYPE transaction_type AS ENUM ('credit', 'debit');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_channel') THEN
        CREATE TYPE notification_channel AS ENUM ('in_app', 'push', 'email', 'sms');
    END IF;
END $$;

-- Core Users Table (Replaces Supabase Auth)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(50) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'customer',
    status user_status NOT NULL DEFAULT 'active',
    is_verified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Refresh Tokens Table for JWT Auth Lifecycle
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- User Profiles Table
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(255),
    avatar_url TEXT,
    date_of_birth DATE,
    time_of_birth TIME,
    place_of_birth VARCHAR(255),
    gender VARCHAR(20),
    latitude NUMERIC(9,6),
    longitude NUMERIC(9,6),
    timezone VARCHAR(100) DEFAULT 'Asia/Kolkata',
    bio TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Astrologer Profiles Table
CREATE TABLE IF NOT EXISTS astrologer_profiles (
    id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(255) NOT NULL,
    bio TEXT,
    experience_years INT NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
    hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (hourly_rate >= 0),
    per_minute_rate NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (per_minute_rate >= 0),
    is_verified BOOLEAN NOT NULL DEFAULT false,
    verification_status verification_status NOT NULL DEFAULT 'pending',
    is_online BOOLEAN NOT NULL DEFAULT false,
    is_busy BOOLEAN NOT NULL DEFAULT false,
    rating NUMERIC(3,2) NOT NULL DEFAULT 5.00 CHECK (rating >= 0 AND rating <= 5),
    total_reviews INT NOT NULL DEFAULT 0 CHECK (total_reviews >= 0),
    total_consultations INT NOT NULL DEFAULT 0 CHECK (total_consultations >= 0),
    languages TEXT[] NOT NULL DEFAULT '{}',
    specializations TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_astrologers_online ON astrologer_profiles(is_online, is_busy);
CREATE INDEX IF NOT EXISTS idx_astrologers_rating ON astrologer_profiles(rating DESC);

-- Astrologer KYC & Verification Documents
CREATE TABLE IF NOT EXISTS astrologer_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    astrologer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type VARCHAR(100) NOT NULL,
    document_url TEXT NOT NULL,
    verification_status verification_status NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_astrologer_docs ON astrologer_documents(astrologer_id);

-- Astrologer Weekly Availability Schedules
CREATE TABLE IF NOT EXISTS astrologer_availability (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    astrologer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_astrologer_avail ON astrologer_availability(astrologer_id, day_of_week);

-- Pandit Profiles Table
CREATE TABLE IF NOT EXISTS pandit_profiles (
    id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    bio TEXT,
    experience_years INT NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
    is_verified BOOLEAN NOT NULL DEFAULT false,
    rating NUMERIC(3,2) NOT NULL DEFAULT 5.00 CHECK (rating >= 0 AND rating <= 5),
    total_poojas INT NOT NULL DEFAULT 0 CHECK (total_poojas >= 0),
    languages TEXT[] NOT NULL DEFAULT '{}',
    city VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pooja Services Catalog
CREATE TABLE IF NOT EXISTS pooja_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    duration_minutes INT NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
    price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    image_url TEXT,
    benefits TEXT[] NOT NULL DEFAULT '{}',
    samagri_included BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pooja Bookings Table
CREATE TABLE IF NOT EXISTS pooja_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    pandit_id UUID REFERENCES users(id) ON DELETE SET NULL,
    pooja_service_id UUID NOT NULL REFERENCES pooja_services(id) ON DELETE RESTRICT,
    booking_date DATE NOT NULL,
    booking_time TIME NOT NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(20),
    gotra VARCHAR(100),
    nakshatra VARCHAR(100),
    special_instructions TEXT,
    total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
    status pooja_booking_state NOT NULL DEFAULT 'REQUESTED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pooja_bookings_user ON pooja_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_pooja_bookings_pandit ON pooja_bookings(pandit_id);
CREATE INDEX IF NOT EXISTS idx_pooja_bookings_status ON pooja_bookings(status);

-- Muhurat Orders Table
CREATE TABLE IF NOT EXISTS muhurat_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    astrologer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    event_name VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    place VARCHAR(255),
    latitude NUMERIC(9,6),
    longitude NUMERIC(9,6),
    timezone VARCHAR(100) DEFAULT 'Asia/Kolkata',
    notes TEXT,
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    report_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_muhurat_orders_user ON muhurat_orders(user_id);

-- Consultations Table
CREATE TABLE IF NOT EXISTS consultations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    astrologer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    type VARCHAR(50) NOT NULL DEFAULT 'chat',
    state consultation_state NOT NULL DEFAULT 'REQUESTED',
    rate_per_minute NUMERIC(10,2) NOT NULL CHECK (rate_per_minute >= 0),
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    total_duration_seconds INT NOT NULL DEFAULT 0 CHECK (total_duration_seconds >= 0),
    total_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (total_amount >= 0),
    astrologer_earnings NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (astrologer_earnings >= 0),
    platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (platform_fee >= 0),
    cancel_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consultations_user ON consultations(user_id);
CREATE INDEX IF NOT EXISTS idx_consultations_astrologer ON consultations(astrologer_id);
CREATE INDEX IF NOT EXISTS idx_consultations_state ON consultations(state);

-- User Wallets Table (Non-negative balance constraint)
CREATE TABLE IF NOT EXISTS wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Double-Entry Wallet Transactions Ledger
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(user_id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    type transaction_type NOT NULL,
    balance_after NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
    reference_type VARCHAR(100) NOT NULL,
    reference_id UUID,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_ref ON wallet_transactions(reference_type, reference_id);

-- Payments Table (Gateway integration)
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    order_id VARCHAR(255) UNIQUE NOT NULL,
    payment_id VARCHAR(255),
    signature VARCHAR(255),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    status payment_status NOT NULL DEFAULT 'pending',
    gateway VARCHAR(50) NOT NULL DEFAULT 'razorpay',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- Provider Earnings Ledger
CREATE TABLE IF NOT EXISTS provider_earnings (
    provider_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_earned NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (total_earned >= 0),
    available_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (available_balance >= 0),
    withdrawn_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (withdrawn_amount >= 0),
    pending_payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (pending_payout_amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Platform Commissions Table
CREATE TABLE IF NOT EXISTS commissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_type VARCHAR(50) NOT NULL CHECK (reference_type IN ('consultation', 'pooja', 'store_order', 'muhurat')),
    reference_id UUID NOT NULL,
    customer_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    provider_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount >= 0),
    commission_rate NUMERIC(5,2) NOT NULL DEFAULT 20.00 CHECK (commission_rate >= 0 AND commission_rate <= 100),
    platform_fee NUMERIC(12,2) NOT NULL CHECK (platform_fee >= 0),
    provider_net_amount NUMERIC(12,2) NOT NULL CHECK (provider_net_amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commissions_provider ON commissions(provider_id);

-- Provider Payout Accounts
CREATE TABLE IF NOT EXISTS payout_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_type VARCHAR(50) NOT NULL CHECK (account_type IN ('bank_account', 'upi')),
    account_holder_name VARCHAR(255) NOT NULL,
    account_number VARCHAR(100),
    ifsc_code VARCHAR(50),
    upi_id VARCHAR(100),
    is_verified BOOLEAN NOT NULL DEFAULT false,
    is_primary BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_acc_provider ON payout_accounts(provider_id);

-- Payout Requests Table
CREATE TABLE IF NOT EXISTS payout_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    payout_account_id UUID REFERENCES payout_accounts(id) ON DELETE RESTRICT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    status payout_request_status NOT NULL DEFAULT 'REQUESTED',
    bank_reference_id TEXT,
    admin_notes TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    processed_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_req_provider ON payout_requests(provider_id);
CREATE INDEX IF NOT EXISTS idx_payout_req_status ON payout_requests(status);

-- Reviews and Ratings Table
CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    astrologer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    consultation_id UUID REFERENCES consultations(id) ON DELETE SET NULL,
    rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    is_anonymous BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_astrologer ON reviews(astrologer_id);

-- Coupons Table
CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
    discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
    min_order_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    max_discount_amount NUMERIC(10,2),
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    usage_limit INT,
    usage_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notifications Table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(100) NOT NULL,
    channel notification_channel NOT NULL DEFAULT 'in_app',
    data JSONB DEFAULT '{}'::jsonb,
    is_read BOOLEAN NOT NULL DEFAULT false,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- Push Notification Devices Table
CREATE TABLE IF NOT EXISTS notification_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_token TEXT UNIQUE NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON notification_devices(user_id);

-- System Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(255) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100),
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(100),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- Saved User Kundli Profiles Table
CREATE TABLE IF NOT EXISTS user_kundli_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    gender VARCHAR(20),
    birth_date DATE NOT NULL,
    birth_time TIME NOT NULL,
    birth_place VARCHAR(255) NOT NULL,
    latitude NUMERIC(9,6) NOT NULL,
    longitude NUMERIC(9,6) NOT NULL,
    timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
    ayanamsha VARCHAR(50) NOT NULL DEFAULT 'LAHIRI',
    chart_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kundli_user ON user_kundli_profiles(user_id);
