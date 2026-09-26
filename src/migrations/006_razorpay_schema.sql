-- ==============================================================================
-- 006_razorpay_schema.sql - Phase 3B Razorpay Real Payment Gateway Schema
-- ==============================================================================

DO $$ BEGIN
    -- Add razorpay fields to payments table if they don't already exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'razorpay_order_id') THEN
        ALTER TABLE payments ADD COLUMN razorpay_order_id VARCHAR(255);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'razorpay_payment_id') THEN
        ALTER TABLE payments ADD COLUMN razorpay_payment_id VARCHAR(255);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'razorpay_signature') THEN
        ALTER TABLE payments ADD COLUMN razorpay_signature VARCHAR(255);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'gateway_status') THEN
        ALTER TABLE payments ADD COLUMN gateway_status VARCHAR(50);
    END IF;

    -- Add razorpay fields to refunds table if they don't already exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'refunds' AND column_name = 'razorpay_refund_id') THEN
        ALTER TABLE refunds ADD COLUMN razorpay_refund_id VARCHAR(255);
    END IF;
END $$;

-- Ensure razorpay_order_id has unique index where not null
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_razorpay_order_id ON payments(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_razorpay_payment_id ON payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refunds_razorpay_refund_id ON refunds(razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL;
