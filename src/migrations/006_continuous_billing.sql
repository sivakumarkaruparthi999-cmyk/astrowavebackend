-- ==============================================================================
-- 006_continuous_billing.sql - Continuous Per-Minute & Reconciled Billing
-- ==============================================================================

-- 1. Add last_billed_minute column to consultations if not exists
ALTER TABLE consultations ADD COLUMN IF NOT EXISTS last_billed_minute INT NOT NULL DEFAULT 0;

-- 2. Ensure astrologer profiles have valid non-zero per_minute_rate
UPDATE astrologer_profiles
SET per_minute_rate = 20.00,
    hourly_rate = 1200.00,
    updated_at = NOW()
WHERE id = 'f7d44301-df84-477f-a4c2-e080768d378c' AND (per_minute_rate IS NULL OR per_minute_rate = 0.00);

UPDATE astrologer_profiles
SET per_minute_rate = CASE 
    WHEN hourly_rate > 0 THEN ROUND((hourly_rate / 60.0)::NUMERIC, 2)
    ELSE 20.00
END,
updated_at = NOW()
WHERE per_minute_rate IS NULL OR per_minute_rate = 0.00;

-- 3. Atomic Per-Minute Billing Tick Procedure
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

    -- Only ACTIVE consultations with valid start_time are billable
    IF v_consultation.state != 'ACTIVE' OR v_consultation.start_time IS NULL THEN
        RETURN QUERY SELECT 'NOT_ACTIVE'::VARCHAR, p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, COALESCE(v_consultation.rate_per_minute, 0.00), 0, COALESCE(v_consultation.last_billed_minute, 0), 0.00::NUMERIC, COALESCE(v_consultation.total_amount, 0.00), 0.00::NUMERIC;
        RETURN;
    END IF;

    -- Calculate elapsed seconds
    v_elapsed_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - v_consultation.start_time)))::INT);
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

    v_new_wallet_balance := v_wallet.balance - v_incremental_charge;
    v_platform_fee := ROUND((v_incremental_charge * (p_platform_commission_rate / 100.0))::NUMERIC, 2);
    v_astrologer_earnings := v_incremental_charge - v_platform_fee;

    -- 4. Deduct wallet atomically
    UPDATE wallets
    SET balance = v_new_wallet_balance,
        updated_at = NOW()
    WHERE wallets.user_id = v_consultation.user_id;

    -- 5. Insert wallet transaction ledger
    INSERT INTO wallet_transactions (
        wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
    ) VALUES (
        v_consultation.user_id,
        v_incremental_charge,
        'debit',
        v_new_wallet_balance,
        'consultation_tick_' || v_elapsed_minutes,
        p_consultation_id,
        'Consultation minute ' || (COALESCE(v_consultation.last_billed_minute, 0) + 1) || ' to ' || v_elapsed_minutes || ' (' || v_consultation.type || ')',
        NOW()
    ) RETURNING id INTO v_wallet_tx_id;

    -- 6. Credit commissions ledger
    INSERT INTO commissions (
        reference_type, reference_id, customer_id, provider_id,
        gross_amount, commission_rate, platform_fee, provider_net_amount, currency, created_at
    ) VALUES (
        'consultation', p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id,
        v_incremental_charge, p_platform_commission_rate, v_platform_fee, v_astrologer_earnings, 'INR', NOW()
    );

    -- 7. Credit astrologer earnings
    INSERT INTO provider_earnings (
        provider_id, total_earned, available_balance, withdrawn_amount, pending_payout_amount, currency, updated_at
    ) VALUES (
        v_consultation.astrologer_id, v_astrologer_earnings, v_astrologer_earnings, 0.00, 0.00, 'INR', NOW()
    )
    ON CONFLICT (provider_id) DO UPDATE
    SET total_earned = provider_earnings.total_earned + v_astrologer_earnings,
        available_balance = provider_earnings.available_balance + v_astrologer_earnings,
        updated_at = NOW();

    -- 8. Update consultation state
    UPDATE consultations
    SET total_amount = COALESCE(total_amount, 0.00) + v_incremental_charge,
        last_billed_minute = v_elapsed_minutes,
        total_duration_seconds = v_elapsed_seconds,
        duration_seconds = v_elapsed_seconds,
        astrologer_earnings = COALESCE(astrologer_earnings, 0.00) + v_astrologer_earnings,
        platform_fee = COALESCE(platform_fee, 0.00) + v_platform_fee,
        updated_at = NOW()
    WHERE id = p_consultation_id;

    RETURN QUERY SELECT 'SUCCESS'::VARCHAR, p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, v_consultation.rate_per_minute, v_elapsed_seconds, v_elapsed_minutes, v_incremental_charge, (COALESCE(v_consultation.total_amount, 0.00) + v_incremental_charge), v_new_wallet_balance;
END;
$$;

-- 4. Reconciled Final Settlement Procedure (settle_consultation_billing_atomic)
CREATE OR REPLACE FUNCTION settle_consultation_billing_atomic(
    p_consultation_id UUID,
    p_duration_seconds INT,
    p_platform_commission_rate NUMERIC(5, 2) DEFAULT 20.00,
    p_idempotency_key VARCHAR(255) DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_consultation RECORD;
    v_wallet RECORD;
    v_existing_billing UUID;
    v_billed_minutes INT;
    v_final_gross_amount NUMERIC(12, 2);
    v_already_charged NUMERIC(12, 2);
    v_remaining_charge NUMERIC(12, 2);
    v_remaining_platform_fee NUMERIC(12, 2);
    v_remaining_astrologer_earnings NUMERIC(12, 2);
    v_total_platform_fee NUMERIC(12, 2);
    v_total_astrologer_earnings NUMERIC(12, 2);
    v_new_wallet_balance NUMERIC(12, 2);
    v_wallet_tx_id UUID;
    v_billing_id UUID;
    v_invoice_number VARCHAR(100);
BEGIN
    -- Idempotency check 1: by idempotency key
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_existing_billing
        FROM consultation_billing
        WHERE idempotency_key = p_idempotency_key;

        IF FOUND THEN
            RETURN v_existing_billing;
        END IF;
    END IF;

    -- Idempotency check 2: by consultation ID if already billed
    SELECT id INTO v_existing_billing
    FROM consultation_billing
    WHERE consultation_id = p_consultation_id;

    IF FOUND THEN
        RETURN v_existing_billing;
    END IF;

    -- Row lock consultation
    SELECT * INTO v_consultation
    FROM consultations
    WHERE id = p_consultation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Consultation % not found', p_consultation_id;
    END IF;

    -- Calculate total duration & final gross amount
    IF p_duration_seconds <= 0 THEN
        v_billed_minutes := 0;
        v_final_gross_amount := 0.00;
    ELSE
        v_billed_minutes := CEIL(p_duration_seconds / 60.0);
        v_final_gross_amount := ROUND((v_billed_minutes * v_consultation.rate_per_minute)::NUMERIC, 2);
    END IF;

    v_already_charged := COALESCE(v_consultation.total_amount, 0.00);
    v_remaining_charge := GREATEST(0.00, v_final_gross_amount - v_already_charged);

    -- Row lock customer wallet
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = v_consultation.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for customer %', v_consultation.user_id;
    END IF;

    -- If remaining charge is needed, debit the remaining amount
    IF v_remaining_charge > 0 THEN
        IF v_wallet.balance < v_remaining_charge THEN
            v_remaining_charge := GREATEST(0.00, v_wallet.balance);
            v_final_gross_amount := v_already_charged + v_remaining_charge;
        END IF;

        IF v_remaining_charge > 0 THEN
            v_new_wallet_balance := v_wallet.balance - v_remaining_charge;
            v_remaining_platform_fee := ROUND((v_remaining_charge * (p_platform_commission_rate / 100.0))::NUMERIC, 2);
            v_remaining_astrologer_earnings := v_remaining_charge - v_remaining_platform_fee;

            -- 1. Deduct wallet
            UPDATE wallets
            SET balance = v_new_wallet_balance,
                updated_at = NOW()
            WHERE wallets.user_id = v_consultation.user_id;

            -- 2. Insert wallet transaction ledger
            INSERT INTO wallet_transactions (
                wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
            ) VALUES (
                v_consultation.user_id,
                v_remaining_charge,
                'debit',
                v_new_wallet_balance,
                'consultation',
                p_consultation_id,
                'Final consultation reconciliation charge (' || v_consultation.type || ')',
                NOW()
            ) RETURNING id INTO v_wallet_tx_id;

            -- 3. Credit platform commissions
            INSERT INTO commissions (
                reference_type, reference_id, customer_id, provider_id,
                gross_amount, commission_rate, platform_fee, provider_net_amount, currency, created_at
            ) VALUES (
                'consultation', p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id,
                v_remaining_charge, p_platform_commission_rate, v_remaining_platform_fee, v_remaining_astrologer_earnings, 'INR', NOW()
            );

            -- 4. Credit astrologer earnings
            INSERT INTO provider_earnings (
                provider_id, total_earned, available_balance, withdrawn_amount, pending_payout_amount, currency, updated_at
            ) VALUES (
                v_consultation.astrologer_id, v_remaining_astrologer_earnings, v_remaining_astrologer_earnings, 0.00, 0.00, 'INR', NOW()
            )
            ON CONFLICT (provider_id) DO UPDATE
            SET total_earned = provider_earnings.total_earned + v_remaining_astrologer_earnings,
                available_balance = provider_earnings.available_balance + v_remaining_astrologer_earnings,
                updated_at = NOW();
        ELSE
            v_new_wallet_balance := v_wallet.balance;
        END IF;
    ELSE
        v_new_wallet_balance := v_wallet.balance;
    END IF;

    v_total_platform_fee := ROUND((v_final_gross_amount * (p_platform_commission_rate / 100.0))::NUMERIC, 2);
    v_total_astrologer_earnings := v_final_gross_amount - v_total_platform_fee;

    -- 5. Insert consultation billing summary record
    INSERT INTO consultation_billing (
        consultation_id, user_id, astrologer_id, rate_per_minute,
        billed_duration_seconds, billed_minutes, gross_amount,
        platform_commission_rate, platform_fee, astrologer_earnings,
        currency, payment_source, wallet_transaction_id, status,
        idempotency_key, created_at
    ) VALUES (
        p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, v_consultation.rate_per_minute,
        p_duration_seconds, v_billed_minutes, v_final_gross_amount,
        p_platform_commission_rate, v_total_platform_fee, v_total_astrologer_earnings,
        'INR', 'wallet', v_wallet_tx_id, 'settled',
        p_idempotency_key, NOW()
    ) RETURNING id INTO v_billing_id;

    -- 6. Generate sequential invoice
    v_invoice_number := 'INV-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(p_consultation_id::TEXT, '-', ''), 1, 8);
    INSERT INTO invoices (
        invoice_number, user_id, reference_type, reference_id,
        subtotal, tax_amount, total_amount, currency, status, created_at, updated_at
    ) VALUES (
        v_invoice_number, v_consultation.user_id, 'consultation', p_consultation_id,
        v_final_gross_amount, 0.00, v_final_gross_amount, 'INR', 'paid', NOW(), NOW()
    )
    ON CONFLICT (invoice_number) DO NOTHING;

    -- 7. Update consultation status
    UPDATE consultations
    SET state = 'ENDED',
        end_time = NOW(),
        total_duration_seconds = p_duration_seconds,
        duration_seconds = p_duration_seconds,
        total_amount = v_final_gross_amount,
        platform_fee = v_total_platform_fee,
        astrologer_earnings = v_total_astrologer_earnings,
        updated_at = NOW()
    WHERE id = p_consultation_id;

    RETURN v_billing_id;
END;
$$;
