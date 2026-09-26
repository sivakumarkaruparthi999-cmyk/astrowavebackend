-- ==============================================================================
-- 004_phase2_schema.sql - Phase 2 AstroTalk Database Architecture
-- Adds Authoritative Tables for:
--   - payment_attempts
--   - refunds
--   - consultation_billing
--   - invoices
-- Adds indexes and safe non-destructive columns.
-- ==============================================================================

-- 1. Payment Attempts Table
CREATE TABLE IF NOT EXISTS payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL DEFAULT 1,
    gateway VARCHAR(50) NOT NULL DEFAULT 'razorpay',
    gateway_order_id VARCHAR(255),
    gateway_payment_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'initiated', -- 'initiated', 'successful', 'failed', 'abandoned'
    error_code VARCHAR(100),
    error_description TEXT,
    raw_response JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Refunds Table
CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    consultation_id UUID REFERENCES consultations(id) ON DELETE SET NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'processed', 'failed'
    reason TEXT NOT NULL,
    gateway_refund_id VARCHAR(255),
    processed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    processed_at TIMESTAMPTZ,
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Consultation Billing Table
CREATE TABLE IF NOT EXISTS consultation_billing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    astrologer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    rate_per_minute NUMERIC(10,2) NOT NULL CHECK (rate_per_minute >= 0),
    billed_duration_seconds INT NOT NULL CHECK (billed_duration_seconds >= 0),
    billed_minutes INT NOT NULL CHECK (billed_minutes >= 0),
    gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount >= 0),
    platform_commission_rate NUMERIC(5,2) NOT NULL DEFAULT 20.00 CHECK (platform_commission_rate >= 0 AND platform_commission_rate <= 100),
    platform_fee NUMERIC(12,2) NOT NULL CHECK (platform_fee >= 0),
    astrologer_earnings NUMERIC(12,2) NOT NULL CHECK (astrologer_earnings >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    payment_source VARCHAR(50) NOT NULL DEFAULT 'wallet', -- 'wallet', 'gateway', 'promotional'
    wallet_transaction_id UUID REFERENCES wallet_transactions(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'settled', -- 'settled', 'failed', 'refunded'
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Invoices Table
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(100) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reference_type VARCHAR(50) NOT NULL, -- 'consultation', 'pooja', 'recharge'
    reference_id UUID NOT NULL,
    subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0),
    total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    billing_name VARCHAR(255),
    billing_address TEXT,
    pdf_url TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'issued', -- 'draft', 'issued', 'paid', 'cancelled'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Safe Table Alterations
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'idempotency_key') THEN
        ALTER TABLE payments ADD COLUMN idempotency_key VARCHAR(255) UNIQUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'description') THEN
        ALTER TABLE payments ADD COLUMN description TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'consultations' AND column_name = 'duration_seconds') THEN
        ALTER TABLE consultations ADD COLUMN duration_seconds INT DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'consultations' AND column_name = 'currency') THEN
        ALTER TABLE consultations ADD COLUMN currency VARCHAR(10) DEFAULT 'INR';
    END IF;
END $$;

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created ON wallet_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_payment ON payment_attempts(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_user ON refunds(user_id);
CREATE INDEX IF NOT EXISTS idx_consultation_billing_consultation ON consultation_billing(consultation_id);
CREATE INDEX IF NOT EXISTS idx_consultation_billing_user ON consultation_billing(user_id);
CREATE INDEX IF NOT EXISTS idx_consultation_billing_astrologer ON consultation_billing(astrologer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
