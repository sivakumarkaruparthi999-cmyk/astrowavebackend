-- ==============================================================================
-- 010_reconcile_wallet_ledger.sql - Authoritative Financial Ledger Reconciliation
-- ==============================================================================

-- 1. Reconcile positive differences (historical opening balances / credits without transaction records)
INSERT INTO wallet_transactions (
    id,
    wallet_id,
    amount,
    type,
    balance_after,
    reference_type,
    reference_id,
    description,
    created_at
)
SELECT 
    gen_random_uuid(),
    w.user_id,
    ROUND((w.balance - COALESCE(s.ledger_sum, 0))::NUMERIC, 2),
    'credit',
    w.balance,
    'ledger_reconciliation',
    gen_random_uuid(),
    'Initial opening balance ledger reconciliation',
    NOW()
FROM wallets w
LEFT JOIN (
    SELECT wallet_id, COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS ledger_sum
    FROM wallet_transactions
    GROUP BY wallet_id
) s ON s.wallet_id = w.user_id
WHERE (w.balance - COALESCE(s.ledger_sum, 0)) > 0.001;

-- 2. Reconcile negative differences if any exist
INSERT INTO wallet_transactions (
    id,
    wallet_id,
    amount,
    type,
    balance_after,
    reference_type,
    reference_id,
    description,
    created_at
)
SELECT 
    gen_random_uuid(),
    w.user_id,
    ROUND((COALESCE(s.ledger_sum, 0) - w.balance)::NUMERIC, 2),
    'debit',
    w.balance,
    'ledger_reconciliation',
    gen_random_uuid(),
    'Ledger reconciliation debit adjustment',
    NOW()
FROM wallets w
LEFT JOIN (
    SELECT wallet_id, COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS ledger_sum
    FROM wallet_transactions
    GROUP BY wallet_id
) s ON s.wallet_id = w.user_id
WHERE (COALESCE(s.ledger_sum, 0) - w.balance) > 0.001;
