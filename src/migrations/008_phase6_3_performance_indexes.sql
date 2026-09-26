-- Phase 6.3 Performance & High-Frequency Query Optimization Indexes

-- 1. Commissions lookup by reference (used in billing verification and reconciliation)
CREATE INDEX IF NOT EXISTS idx_commissions_ref ON commissions (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_commissions_created ON commissions (created_at DESC);

-- 2. Consultations history pagination (used in customer and astrologer history listing)
CREATE INDEX IF NOT EXISTS idx_consultations_user_created ON consultations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultations_astro_created ON consultations (astrologer_id, created_at DESC);

-- 3. Notifications pagination and unread filtering
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);

-- 4. Wallet transactions history pagination
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet_created ON wallet_transactions (wallet_id, created_at DESC);

-- 5. Payments user history pagination
CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments (user_id, created_at DESC);

-- 6. Pooja bookings user history pagination
CREATE INDEX IF NOT EXISTS idx_pooja_bookings_user_created ON pooja_bookings (user_id, created_at DESC);

-- 7. Astrologer reviews pagination
CREATE INDEX IF NOT EXISTS idx_reviews_astrologer_created ON reviews (astrologer_id, created_at DESC);
