-- ==============================================================================
-- 002_functions.sql - Financial & Atomic Transaction Procedures
-- Non-destructive double-entry financial procedures with row locking
-- ==============================================================================

-- 1. Credit Wallet Procedure
CREATE OR REPLACE FUNCTION credit_wallet(
    p_user_id UUID,
    p_amount NUMERIC(12, 2),
    p_reference_type VARCHAR(100),
    p_reference_id UUID,
    p_description TEXT
)
RETURNS NUMERIC(12, 2)
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_balance NUMERIC(12, 2);
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Credit amount must be positive';
    END IF;

    -- Ensure wallet exists with row lock
    INSERT INTO wallets (user_id, balance, currency, updated_at)
    VALUES (p_user_id, p_amount, 'INR', NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET balance = wallets.balance + p_amount,
        updated_at = NOW()
    RETURNING balance INTO v_new_balance;

    -- Record in immutable ledger
    INSERT INTO wallet_transactions (
        wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
    ) VALUES (
        p_user_id, p_amount, 'credit', v_new_balance, p_reference_type, p_reference_id, p_description, NOW()
    );

    RETURN v_new_balance;
END;
$$;

-- 2. Deduct Wallet Procedure
CREATE OR REPLACE FUNCTION deduct_wallet(
    p_user_id UUID,
    p_amount NUMERIC(12, 2),
    p_reference_type VARCHAR(100),
    p_reference_id UUID,
    p_description TEXT
)
RETURNS NUMERIC(12, 2)
LANGUAGE plpgsql
AS $$
DECLARE
    v_current_balance NUMERIC(12, 2);
    v_new_balance NUMERIC(12, 2);
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Debit amount must be positive';
    END IF;

    -- Row lock on wallet
    SELECT balance INTO v_current_balance
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
    END IF;

    IF v_current_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient balance: available %, requested %', v_current_balance, p_amount;
    END IF;

    v_new_balance := v_current_balance - p_amount;

    UPDATE wallets
    SET balance = v_new_balance,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Record in immutable ledger
    INSERT INTO wallet_transactions (
        wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
    ) VALUES (
        p_user_id, p_amount, 'debit', v_new_balance, p_reference_type, p_reference_id, p_description, NOW()
    );

    RETURN v_new_balance;
END;
$$;

-- 3. Settle Consultation Earnings Procedure
CREATE OR REPLACE FUNCTION settle_consultation_earnings(
    p_consultation_id UUID,
    p_total_amount NUMERIC(12, 2),
    p_platform_commission_rate NUMERIC(5, 2) DEFAULT 20.00
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_consultation RECORD;
    v_platform_fee NUMERIC(12, 2);
    v_astrologer_earnings NUMERIC(12, 2);
BEGIN
    SELECT * INTO v_consultation
    FROM consultations
    WHERE id = p_consultation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Consultation % not found', p_consultation_id;
    END IF;

    v_platform_fee := ROUND((p_total_amount * (p_platform_commission_rate / 100.0)), 2);
    v_astrologer_earnings := p_total_amount - v_platform_fee;

    -- Update consultation record
    UPDATE consultations
    SET total_amount = p_total_amount,
        platform_fee = v_platform_fee,
        astrologer_earnings = v_astrologer_earnings,
        state = 'ENDED',
        updated_at = NOW()
    WHERE id = p_consultation_id;

    -- Record platform commission
    INSERT INTO commissions (
        reference_type, reference_id, customer_id, provider_id,
        gross_amount, commission_rate, platform_fee, provider_net_amount, currency
    ) VALUES (
        'consultation', p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id,
        p_total_amount, p_platform_commission_rate, v_platform_fee, v_astrologer_earnings, 'INR'
    );

    -- Credit astrologer provider earnings ledger
    INSERT INTO provider_earnings (
        provider_id, total_earned, available_balance, withdrawn_amount, pending_payout_amount, currency, updated_at
    ) VALUES (
        v_consultation.astrologer_id, v_astrologer_earnings, v_astrologer_earnings, 0.00, 0.00, 'INR', NOW()
    )
    ON CONFLICT (provider_id) DO UPDATE
    SET total_earned = provider_earnings.total_earned + v_astrologer_earnings,
        available_balance = provider_earnings.available_balance + v_astrologer_earnings,
        updated_at = NOW();

    -- Increment astrologer total consultations
    UPDATE astrologer_profiles
    SET total_consultations = total_consultations + 1,
        updated_at = NOW()
    WHERE id = v_consultation.astrologer_id;
END;
$$;

-- 4. Process Payout Approval Procedure
CREATE OR REPLACE FUNCTION process_payout_approval(
    p_payout_request_id UUID,
    p_admin_id UUID,
    p_action VARCHAR(20), -- 'APPROVE', 'REJECT', 'COMPLETE'
    p_notes TEXT DEFAULT NULL,
    p_bank_reference TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_request RECORD;
BEGIN
    SELECT * INTO v_request
    FROM payout_requests
    WHERE id = p_payout_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout request % not found', p_payout_request_id;
    END IF;

    IF p_action = 'APPROVE' THEN
        UPDATE payout_requests
        SET status = 'APPROVED',
            admin_notes = p_notes,
            processed_by = p_admin_id,
            updated_at = NOW()
        WHERE id = p_payout_request_id;

    ELSIF p_action = 'COMPLETE' THEN
        UPDATE payout_requests
        SET status = 'COMPLETED',
            bank_reference_id = p_bank_reference,
            admin_notes = p_notes,
            completed_at = NOW(),
            processed_by = p_admin_id,
            updated_at = NOW()
        WHERE id = p_payout_request_id;

        -- Update provider earnings: transfer from pending to withdrawn
        UPDATE provider_earnings
        SET pending_payout_amount = pending_payout_amount - v_request.amount,
            withdrawn_amount = withdrawn_amount + v_request.amount,
            updated_at = NOW()
        WHERE provider_id = v_request.provider_id;

    ELSIF p_action = 'REJECT' THEN
        UPDATE payout_requests
        SET status = 'REJECTED',
            admin_notes = p_notes,
            processed_by = p_admin_id,
            updated_at = NOW()
        WHERE id = p_payout_request_id;

        -- Refund pending amount back to available balance
        UPDATE provider_earnings
        SET pending_payout_amount = pending_payout_amount - v_request.amount,
            available_balance = available_balance + v_request.amount,
            updated_at = NOW()
        WHERE provider_id = v_request.provider_id;
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;
END;
$$;
