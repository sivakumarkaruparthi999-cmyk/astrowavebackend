-- ==============================================================================
-- 007_phase5a_database_security.sql - Phase 5A Database Security Hardening
-- PostgreSQL RLS, Least Privilege Roles, Connection Bounds & Invariants
-- ==============================================================================

-- 1. Create Least-Privilege Application Role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'astrowave_app') THEN
    CREATE ROLE astrowave_app WITH LOGIN PASSWORD 'astrowave_app_secure_pw' 
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Grant minimal necessary privileges to astrowave_app
GRANT CONNECT ON DATABASE astrotalk TO astrowave_app;
GRANT USAGE ON SCHEMA public TO astrowave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO astrowave_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO astrowave_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO astrowave_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO astrowave_app;

-- 2. Context Helper Functions for RLS
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_current_user_role() RETURNS TEXT AS $$
  SELECT COALESCE(current_setting('app.current_user_role', true), 'anonymous');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_system() RETURNS BOOLEAN AS $$
  SELECT COALESCE(current_setting('app.is_system', true), 'false') = 'true'
         OR current_setting('app.current_user_role', true) = 'admin'
         OR current_user = 'postgres';
$$ LANGUAGE sql STABLE;

-- 3. Row-Level Security (RLS) on Sensitive Tables

-- Wallets
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_owner_policy ON wallets;
CREATE POLICY wallet_owner_policy ON wallets FOR ALL 
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- Wallet Transactions
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_transactions_owner_policy ON wallet_transactions;
CREATE POLICY wallet_transactions_owner_policy ON wallet_transactions FOR ALL 
  USING (wallet_id = app_current_user_id() OR app_is_system())
  WITH CHECK (wallet_id = app_current_user_id() OR app_is_system());

-- User Kundli Profiles
ALTER TABLE user_kundli_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kundli_owner_policy ON user_kundli_profiles;
CREATE POLICY kundli_owner_policy ON user_kundli_profiles FOR ALL 
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- Astrologer Documents (KYC)
ALTER TABLE astrologer_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS astrologer_docs_policy ON astrologer_documents;
CREATE POLICY astrologer_docs_policy ON astrologer_documents FOR ALL 
  USING (astrologer_id = app_current_user_id() OR app_is_system())
  WITH CHECK (astrologer_id = app_current_user_id() OR app_is_system());

-- Payout Accounts
ALTER TABLE payout_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payout_accounts_policy ON payout_accounts;
CREATE POLICY payout_accounts_policy ON payout_accounts FOR ALL 
  USING (provider_id = app_current_user_id() OR app_is_system())
  WITH CHECK (provider_id = app_current_user_id() OR app_is_system());

-- Payout Requests
ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payout_requests_policy ON payout_requests;
CREATE POLICY payout_requests_policy ON payout_requests FOR ALL 
  USING (provider_id = app_current_user_id() OR app_is_system())
  WITH CHECK (provider_id = app_current_user_id() OR app_is_system());

-- Consultations (Participant Policy)
ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consultation_participant_policy ON consultations;
CREATE POLICY consultation_participant_policy ON consultations FOR ALL 
  USING (user_id = app_current_user_id() OR astrologer_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR astrologer_id = app_current_user_id() OR app_is_system());

-- Consultation Billing
ALTER TABLE consultation_billing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consultation_billing_policy ON consultation_billing;
CREATE POLICY consultation_billing_policy ON consultation_billing FOR ALL 
  USING (user_id = app_current_user_id() OR astrologer_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR astrologer_id = app_current_user_id() OR app_is_system());

-- Invoices
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_owner_policy ON invoices;
CREATE POLICY invoice_owner_policy ON invoices FOR ALL 
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- Notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_owner_policy ON notifications;
CREATE POLICY notification_owner_policy ON notifications FOR ALL 
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- Notification Devices
ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_devices_policy ON notification_devices;
CREATE POLICY notification_devices_policy ON notification_devices FOR ALL 
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- Password Resets
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS password_resets_policy ON password_resets;
CREATE POLICY password_resets_policy ON password_resets FOR ALL 
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- Refresh Tokens
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refresh_tokens_policy ON refresh_tokens;
CREATE POLICY refresh_tokens_policy ON refresh_tokens FOR ALL 
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- Audit Logs (Admin & System only)
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_policy ON audit_logs;
CREATE POLICY audit_logs_policy ON audit_logs FOR ALL 
  USING (app_is_system())
  WITH CHECK (app_is_system());

-- Provider Earnings
ALTER TABLE provider_earnings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_earnings_policy ON provider_earnings;
CREATE POLICY provider_earnings_policy ON provider_earnings FOR ALL 
  USING (provider_id = app_current_user_id() OR app_is_system())
  WITH CHECK (provider_id = app_current_user_id() OR app_is_system());

-- Reviews (Public Read, Owner Insert)
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reviews_read_policy ON reviews;
CREATE POLICY reviews_read_policy ON reviews FOR SELECT USING (true);
DROP POLICY IF EXISTS reviews_write_policy ON reviews;
CREATE POLICY reviews_write_policy ON reviews FOR INSERT 
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- 4. Invariants & Business Constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_wallet_balance_non_negative'
  ) THEN
    ALTER TABLE wallets ADD CONSTRAINT check_wallet_balance_non_negative CHECK (balance >= 0.00);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_provider_available_balance_non_negative'
  ) THEN
    ALTER TABLE provider_earnings ADD CONSTRAINT check_provider_available_balance_non_negative CHECK (available_balance >= 0.00);
  END IF;
END
$$;

-- 5. Foreign Key & Query Performance Indexes
CREATE INDEX IF NOT EXISTS idx_user_kundli_profiles_user_id ON user_kundli_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_payout_requests_provider_id ON payout_requests(provider_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_user_id ON refunds(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_astrologer_id ON reviews(astrologer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_consultations_user_id ON consultations(user_id);
CREATE INDEX IF NOT EXISTS idx_consultations_astrologer_id ON consultations(astrologer_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON wallet_transactions(wallet_id);
