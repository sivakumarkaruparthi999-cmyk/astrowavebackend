import pkg from 'pg';
import dotenv from 'dotenv';
const { Client } = pkg;
dotenv.config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('Connected to PostgreSQL. Starting hardening transaction...');
  await client.query('BEGIN');

  // 1. Clean historical duplicate test rows from 2026-09-11
  await client.query(`
    DELETE FROM wallet_transactions 
    WHERE id IN (
      '5afb6a39-e8c1-4351-8482-209abf042f34',
      '54de09dc-780a-4fd2-9261-d5199ab53b47',
      '375aca4b-0175-4509-addd-d4956004649e'
    )
  `);
  console.log('Cleaned historical duplicate test rows.');

  // 2. Ensure unique constraint on wallet_transactions for reference idempotency
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_unique_ref 
    ON wallet_transactions (wallet_id, reference_type, reference_id) 
    WHERE reference_id IS NOT NULL
  `);
  console.log('Created idx_wallet_transactions_unique_ref.');

  // 3. Ensure unique constraint on consultation_billing for consultation_id
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consultation_billing_unique_consultation 
    ON consultation_billing (consultation_id)
  `);
  console.log('Created idx_consultation_billing_unique_consultation.');

  // 4. Update settle_consultation_billing_atomic to check state after FOR UPDATE lock
  await client.query(`
CREATE OR REPLACE FUNCTION public.settle_consultation_billing_atomic(
    p_consultation_id uuid,
    p_duration_seconds integer,
    p_platform_commission_rate numeric DEFAULT 20.00,
    p_idempotency_key character varying DEFAULT NULL::character varying
)
RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
    v_consultation RECORD;
    v_wallet RECORD;
    v_existing_billing UUID;
    v_billed_minutes INT;
    v_gross_amount NUMERIC(12, 2);
    v_platform_fee NUMERIC(12, 2);
    v_astrologer_earnings NUMERIC(12, 2);
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

    -- Post-lock idempotency check: if another concurrent transaction ended and settled it
    IF v_consultation.state = 'ENDED' THEN
        SELECT id INTO v_existing_billing
        FROM consultation_billing
        WHERE consultation_id = p_consultation_id;
        IF FOUND THEN
            RETURN v_existing_billing;
        END IF;
    END IF;

    -- Calculate duration & gross amount
    IF p_duration_seconds <= 0 THEN
        v_billed_minutes := 1;
    ELSE
        v_billed_minutes := CEIL(p_duration_seconds / 60.0);
    END IF;

    v_gross_amount := ROUND((v_billed_minutes * v_consultation.rate_per_minute)::NUMERIC, 2);
    v_platform_fee := ROUND((v_gross_amount * (p_platform_commission_rate / 100.0))::NUMERIC, 2);
    v_astrologer_earnings := v_gross_amount - v_platform_fee;

    -- Row lock customer wallet
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = v_consultation.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for customer %', v_consultation.user_id;
    END IF;

    IF v_wallet.balance < v_gross_amount THEN
        RAISE EXCEPTION 'Insufficient balance: available %, required %', v_wallet.balance, v_gross_amount;
    END IF;

    v_new_wallet_balance := v_wallet.balance - v_gross_amount;

    -- 1. Deduct wallet
    UPDATE wallets
    SET balance = v_new_wallet_balance,
        updated_at = NOW()
    WHERE user_id = v_consultation.user_id;

    -- 2. Insert wallet transaction ledger
    INSERT INTO wallet_transactions (
        wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
    ) VALUES (
        v_consultation.user_id,
        v_gross_amount,
        'debit',
        v_new_wallet_balance,
        'consultation',
        p_consultation_id,
        'Consultation charge for ' || v_billed_minutes || ' min(s)',
        NOW()
    ) RETURNING id INTO v_wallet_tx_id;

    -- 3. Insert consultation billing record
    INSERT INTO consultation_billing (
        consultation_id, user_id, astrologer_id, rate_per_minute,
        billed_duration_seconds, billed_minutes, gross_amount,
        platform_commission_rate, platform_fee, astrologer_earnings,
        currency, payment_source, wallet_transaction_id, status,
        idempotency_key, created_at
    ) VALUES (
        p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id, v_consultation.rate_per_minute,
        p_duration_seconds, v_billed_minutes, v_gross_amount,
        p_platform_commission_rate, v_platform_fee, v_astrologer_earnings,
        'INR', 'wallet', v_wallet_tx_id, 'settled',
        p_idempotency_key, NOW()
    ) RETURNING id INTO v_billing_id;

    -- 4. Credit platform commissions ledger
    INSERT INTO commissions (
        reference_type, reference_id, customer_id, provider_id,
        gross_amount, commission_rate, platform_fee, provider_net_amount, currency, created_at
    ) VALUES (
        'consultation', p_consultation_id, v_consultation.user_id, v_consultation.astrologer_id,
        v_gross_amount, p_platform_commission_rate, v_platform_fee, v_astrologer_earnings, 'INR', NOW()
    );

    -- 5. Credit astrologer earnings ledger
    INSERT INTO provider_earnings (
        provider_id, total_earned, available_balance, withdrawn_amount, pending_payout_amount, currency, updated_at
    ) VALUES (
        v_consultation.astrologer_id, v_astrologer_earnings, v_astrologer_earnings, 0.00, 0.00, 'INR', NOW()
    )
    ON CONFLICT (provider_id) DO UPDATE
    SET total_earned = provider_earnings.total_earned + v_astrologer_earnings,
        available_balance = provider_earnings.available_balance + v_astrologer_earnings,
        updated_at = NOW();

    -- 6. Generate sequential invoice
    v_invoice_number := 'INV-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(p_consultation_id::TEXT, '-', ''), 1, 8);
    INSERT INTO invoices (
        invoice_number, user_id, reference_type, reference_id,
        subtotal, tax_amount, total_amount, currency, status, created_at, updated_at
    ) VALUES (
        v_invoice_number, v_consultation.user_id, 'consultation', p_consultation_id,
        v_gross_amount, 0.00, v_gross_amount, 'INR', 'paid', NOW(), NOW()
    )
    ON CONFLICT (invoice_number) DO NOTHING;

    -- 7. Update consultation status
    UPDATE consultations
    SET state = 'ENDED',
        end_time = NOW(),
        total_duration_seconds = p_duration_seconds,
        duration_seconds = p_duration_seconds,
        total_amount = v_gross_amount,
        platform_fee = v_platform_fee,
        astrologer_earnings = v_astrologer_earnings,
        updated_at = NOW()
    WHERE id = p_consultation_id;

    -- 8. Release astrologer busy status & increment counter
    UPDATE astrologer_profiles
    SET is_busy = false,
        total_consultations = total_consultations + 1,
        updated_at = NOW()
    WHERE id = v_consultation.astrologer_id;

    RETURN v_billing_id;
END;
$function$;
  `);
  console.log('Updated settle_consultation_billing_atomic.');

  // 5. Update process_refund_atomic to lock payment first and check idempotency under lock
  await client.query(`
CREATE OR REPLACE FUNCTION public.process_refund_atomic(
    p_payment_id uuid,
    p_amount numeric,
    p_reason text,
    p_processed_by uuid DEFAULT NULL::uuid,
    p_idempotency_key character varying DEFAULT NULL::character varying
)
RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
    v_payment RECORD;
    v_wallet RECORD;
    v_existing_refund UUID;
    v_refund_id UUID;
    v_new_balance NUMERIC(12, 2);
BEGIN
    -- Row lock payment FIRST to serialize concurrent refund attempts
    SELECT * INTO v_payment
    FROM payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment % not found', p_payment_id;
    END IF;

    -- Idempotency check under row lock
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_existing_refund
        FROM refunds
        WHERE idempotency_key = p_idempotency_key;

        IF FOUND THEN
            RETURN v_existing_refund;
        END IF;
    END IF;

    IF v_payment.status NOT IN ('paid', 'partially_refunded') THEN
        -- If already refunded with same idempotency key, return existing refund
        IF p_idempotency_key IS NOT NULL THEN
            SELECT id INTO v_existing_refund
            FROM refunds
            WHERE idempotency_key = p_idempotency_key;

            IF FOUND THEN
                RETURN v_existing_refund;
            END IF;
        END IF;

        RAISE EXCEPTION 'Payment % cannot be refunded because status is %', p_payment_id, v_payment.status;
    END IF;

    IF p_amount <= 0 OR p_amount > v_payment.amount THEN
        RAISE EXCEPTION 'Invalid refund amount: % (original payment: %)', p_amount, v_payment.amount;
    END IF;

    -- Lock wallet and verify user has enough balance to reverse recharge
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = v_payment.user_id
    FOR UPDATE;

    IF FOUND AND v_wallet.balance >= p_amount THEN
        v_new_balance := v_wallet.balance - p_amount;
        UPDATE wallets
        SET balance = v_new_balance,
            updated_at = NOW()
        WHERE user_id = v_payment.user_id;

        INSERT INTO wallet_transactions (
            wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
        ) VALUES (
            v_payment.user_id,
            p_amount,
            'debit',
            v_new_balance,
            'refund',
            p_payment_id,
            'Refund reversal: ' || p_reason,
            NOW()
        );
    END IF;

    -- Insert refund record
    INSERT INTO refunds (
        payment_id, user_id, amount, currency, status, reason,
        gateway_refund_id, processed_by, processed_at, idempotency_key, created_at, updated_at
    ) VALUES (
        p_payment_id, v_payment.user_id, p_amount, v_payment.currency, 'processed', p_reason,
        'rfnd_' || SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 12),
        p_processed_by, NOW(), p_idempotency_key, NOW(), NOW()
    ) RETURNING id INTO v_refund_id;

    -- Update payment status
    UPDATE payments
    SET status = 'refunded',
        updated_at = NOW()
    WHERE id = p_payment_id;

    RETURN v_refund_id;
END;
$function$;
  `);
  console.log('Updated process_refund_atomic.');

  await client.query('COMMIT');
  console.log('Hardening transaction committed successfully.');
  await client.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
