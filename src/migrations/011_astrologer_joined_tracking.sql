-- ==============================================================================
-- 011_astrologer_joined_tracking.sql - Track When Astrologer Joins to Delay Billing
-- Amount must NOT be deducted until astrologer joins the consultation.
-- ==============================================================================

-- 1. Add astrologer_joined_at column to consultations
ALTER TABLE consultations ADD COLUMN IF NOT EXISTS astrologer_joined_at TIMESTAMPTZ;

-- 2. Update existing active/ended consultations that had start_time to preserve history
UPDATE consultations
SET astrologer_joined_at = start_time
WHERE astrologer_joined_at IS NULL AND start_time IS NOT NULL AND state IN ('ACTIVE', 'ENDED');

-- 3. Replace bill_consultation_minute_tick_atomic to strictly require astrologer_joined_at
CREATE OR REPLACE FUNCTION bill_consultation_minute_tick_atomic(
    p_consultation_id UUID,
    p_platform_commission_rate NUMERIC(5, 2) DEFAULT 20.00
)
RETURNS TABLE (
    status VARCHAR,
    consultation_id UUID,
    user_id UUID,
    astrologer_id UUID,
    rate_per_minute NUMERIC,
    elapsed_seconds INT,
    billed_minute INT,
    incremental_charge NUMERIC,
    total_charged NUMERIC,
    wallet_balance NUMERIC
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_consultation RECORD;
    v_wallet RECORD;
    v_elapsed_seconds INT;
    v_elapsed_minutes INT;
    v_minutes_to_bill INT;
    v_incremental_charge NUMERIC(12, 2);
    v_platform_fee NUMERIC(12, 2);
    v_astrologer_earnings NUMERIC(12, 2);
    v_new_wallet_balance NUMERIC(12, 2);
    v_wallet_tx_id UUID;
    v_effective_start TIMESTAMPTZ;
BEGIN
    -- 1. Row lock consultation
    SELECT * INTO v_consultation
    FROM consultations
    WHERE id = p_consultation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::VARCHAR, p_consultation_id, NULL::UUID, NULL::UUID, 0.00::NUMERIC, 0, 0, 0.00::NUMERIC, 0.00::NUMERIC, 0.00::NUMERIC;
        RETURN;
    END IF;

    -- CRITICAL BUSINESS RULE: Only ACTIVE consultations where astrologer has actually joined are billable!
    IF v_consultation.state != 'ACTIVE' OR v_consultation.astrologer_joined_at IS NULL THEN
        RETURN QUERY SELECT 'NOT_ACTIVE'::VARCHAR, p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, COALESCE(v_consultation.rate_per_minute, 0.00), 0, COALESCE(v_consultation.last_billed_minute, 0), 0.00::NUMERIC, COALESCE(v_consultation.total_amount, 0.00), 0.00::NUMERIC;
        RETURN;
    END IF;

    v_effective_start := v_consultation.astrologer_joined_at;

    -- Calculate elapsed seconds strictly from when the astrologer joined
    v_elapsed_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - v_effective_start)))::INT);
    v_elapsed_minutes := FLOOR(v_elapsed_seconds / 60.0)::INT;

    -- If no new minute has elapsed since last billed minute, nothing to bill
    IF v_elapsed_minutes <= COALESCE(v_consultation.last_billed_minute, 0) THEN
        RETURN QUERY SELECT 'NO_TICK'::VARCHAR, p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, v_consultation.rate_per_minute, v_elapsed_seconds, COALESCE(v_consultation.last_billed_minute, 0), 0.00::NUMERIC, COALESCE(v_consultation.total_amount, 0.00), 0.00::NUMERIC;
        RETURN;
    END IF;

    v_minutes_to_bill := v_elapsed_minutes - COALESCE(v_consultation.last_billed_minute, 0);
    v_incremental_charge := ROUND((v_minutes_to_bill * v_consultation.rate_per_minute)::NUMERIC, 2);

    -- 2. Row lock customer wallet
    SELECT * INTO v_wallet
    FROM wallets
    WHERE wallets.user_id = v_consultation.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'WALLET_NOT_FOUND'::VARCHAR, p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, v_consultation.rate_per_minute, v_elapsed_seconds, COALESCE(v_consultation.last_billed_minute, 0), 0.00::NUMERIC, COALESCE(v_consultation.total_amount, 0.00), 0.00::NUMERIC;
        RETURN;
    END IF;

    -- 3. Check for insufficient balance
    IF v_wallet.balance < v_incremental_charge THEN
        RETURN QUERY SELECT 'INSUFFICIENT_BALANCE'::VARCHAR, p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, v_consultation.rate_per_minute, v_elapsed_seconds, COALESCE(v_consultation.last_billed_minute, 0), v_incremental_charge, COALESCE(v_consultation.total_amount, 0.00), v_wallet.balance;
        RETURN;
    END IF;

    -- 4. Deduct incremental charge atomically
    UPDATE wallets
    SET balance = balance - v_incremental_charge,
        updated_at = NOW()
    WHERE wallets.user_id = v_consultation.user_id
    RETURNING wallets.balance INTO v_new_wallet_balance;

    -- 5. Split platform commission and astrologer earnings
    v_platform_fee := ROUND((v_incremental_charge * (p_platform_commission_rate / 100.0))::NUMERIC, 2);
    v_astrologer_earnings := v_incremental_charge - v_platform_fee;

    -- 6. Record wallet debit transaction
    INSERT INTO wallet_transactions (
        wallet_id, amount, type, balance_after, reference_type, reference_id, description
    ) VALUES (
        v_consultation.user_id,
        v_incremental_charge,
        'debit',
        v_new_wallet_balance,
        'consultation_tick',
        v_consultation.id,
        'Continuous per-minute charge for consultation (Minute ' || v_elapsed_minutes || ')'
    ) RETURNING id INTO v_wallet_tx_id;

    -- 7. Update consultation aggregate billing figures
    UPDATE consultations
    SET last_billed_minute = v_elapsed_minutes,
        total_duration_seconds = v_elapsed_seconds,
        duration_seconds = v_elapsed_seconds,
        total_amount = total_amount + v_incremental_charge,
        astrologer_earnings = astrologer_earnings + v_astrologer_earnings,
        platform_fee = platform_fee + v_platform_fee,
        updated_at = NOW()
    WHERE id = p_consultation_id;

    -- 8. Return successful tick summary
    RETURN QUERY SELECT
        'SUCCESS'::VARCHAR,
        p_consultation_id,
        v_consultation.user_id,
        v_consultation.astrologer_id,
        v_consultation.rate_per_minute,
        v_elapsed_seconds,
        v_elapsed_minutes,
        v_incremental_charge,
        ROUND((v_consultation.total_amount + v_incremental_charge)::NUMERIC, 2),
        v_new_wallet_balance;
END;
$$;
