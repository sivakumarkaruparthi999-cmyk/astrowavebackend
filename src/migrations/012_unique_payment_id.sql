-- Fix 9: Unique Constraint / Index on payment_id
-- Prevents duplicate payment credit attacks at the database storage level.

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_payment_id 
ON payments(payment_id) 
WHERE payment_id IS NOT NULL;

