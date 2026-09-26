-- ==============================================================================
-- 009_consolidate_payment_columns.sql - Consolidate duplicate payment columns
-- ==============================================================================

DO $$ BEGIN
    -- 1. Defensive backfill: ensure canonical columns have data from duplicate columns if canonical is NULL
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'razorpay_order_id') THEN
        UPDATE payments 
        SET order_id = razorpay_order_id 
        WHERE (order_id IS NULL OR order_id = '') AND razorpay_order_id IS NOT NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'razorpay_payment_id') THEN
        UPDATE payments 
        SET payment_id = razorpay_payment_id 
        WHERE (payment_id IS NULL OR payment_id = '') AND razorpay_payment_id IS NOT NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'razorpay_signature') THEN
        UPDATE payments 
        SET signature = razorpay_signature 
        WHERE (signature IS NULL OR signature = '') AND razorpay_signature IS NOT NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'refunds' AND column_name = 'razorpay_refund_id') THEN
        UPDATE refunds 
        SET gateway_refund_id = razorpay_refund_id 
        WHERE (gateway_refund_id IS NULL OR gateway_refund_id = '') AND razorpay_refund_id IS NOT NULL;
    END IF;
END $$;

-- 2. Drop redundant indexes on duplicate columns
DROP INDEX IF EXISTS idx_payments_razorpay_order_id;
DROP INDEX IF EXISTS idx_payments_razorpay_payment_id;
DROP INDEX IF EXISTS idx_refunds_razorpay_refund_id;

-- 3. Drop duplicate columns safely
ALTER TABLE payments DROP COLUMN IF EXISTS razorpay_order_id;
ALTER TABLE payments DROP COLUMN IF EXISTS razorpay_payment_id;
ALTER TABLE payments DROP COLUMN IF EXISTS razorpay_signature;
ALTER TABLE refunds DROP COLUMN IF EXISTS razorpay_refund_id;
