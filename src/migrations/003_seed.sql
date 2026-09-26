-- ==============================================================================
-- 003_seed.sql - Development & Initial Seed Data
-- ==============================================================================

-- Admin User: admin@astro.com / Admin@123
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'admin@astro.com',
    '+919876543210',
    '$2b$10$9AgqeGE2uNnEJi0hN/lXhOg/uvt5SLwWzgzYpFYOnomKN7QCHvZhG',
    'super_admin',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, full_name, avatar_url, bio, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'System Administrator',
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    'Super Administrator for AstroTalk platform',
    NOW()
) ON CONFLICT (id) DO NOTHING;

-- Demo Astrologer: astrologer@astro.com / Astro@123
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    'astrologer@astro.com',
    '+919876543211',
    '$2b$10$T3CbQtGApx9ziyK/JEOrHewgCWvZTWFFou4jnP6GUL9XkO4kRbZ6C',
    'astrologer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, full_name, avatar_url, bio, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    'Acharya Sharma',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
    'Vedic Astrologer and Vastu Expert with 15+ years experience',
    NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO astrologer_profiles (
    id, display_name, bio, experience_years, hourly_rate, per_minute_rate,
    is_verified, verification_status, is_online, is_busy, rating, total_reviews, total_consultations,
    languages, specializations
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    'Acharya Sharma',
    'Specialist in Kundli Matching, Career Astrology, and Vedic Remedies',
    15,
    1200.00,
    20.00,
    true,
    'approved',
    true,
    false,
    4.95,
    342,
    1250,
    ARRAY['Hindi', 'English', 'Sanskrit'],
    ARRAY['Vedic', 'Kundli', 'Career', 'Relationship', 'Vastu']
) ON CONFLICT (id) DO NOTHING;

-- Demo Customer User: customer@astro.com / User@123
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000003',
    'customer@astro.com',
    '+919876543212',
    '$2b$10$R9PlxlNIH1AtpfCu/Me3OeDVcaXoF7CXOEhR4rEE43MRhB2g8H3uK',
    'customer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, full_name, avatar_url, bio, date_of_birth, time_of_birth, place_of_birth, gender, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000003',
    'Rahul Verma',
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
    'Spiritual seeker and astrology enthusiast',
    '1995-08-15',
    '06:30:00',
    'New Delhi, India',
    'Male',
    NOW()
) ON CONFLICT (id) DO NOTHING;

-- Initialize Customer Wallet with 500 INR balance
INSERT INTO wallets (user_id, balance, currency, updated_at)
VALUES ('00000000-0000-0000-0000-000000000003', 500.00, 'INR', NOW())
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO wallet_transactions (
    wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
) VALUES (
    '00000000-0000-0000-0000-000000000003', 500.00, 'credit', 500.00, 'welcome_bonus', gen_random_uuid(), 'Sign up welcome credit', NOW()
);

-- Seed Pooja Services
INSERT INTO pooja_services (id, name, slug, description, duration_minutes, price, image_url, benefits, samagri_included, is_active)
VALUES 
(
    '10000000-0000-0000-0000-000000000001',
    'Maha Ganapati Pooja',
    'maha-ganapati-pooja',
    'Removes all obstacles and brings success, peace, and prosperity to new beginnings.',
    45,
    1500.00,
    'https://images.unsplash.com/photo-1583089892943-e02e5b017b6a?w=400',
    ARRAY['Obstacle Removal', 'Prosperity in Business', 'Wisdom and Intellect'],
    true,
    true
),
(
    '10000000-0000-0000-0000-000000000002',
    'Navagraha Shanti Havan',
    'navagraha-shanti-havan',
    'Pacifies all nine planetary doshas and balances planetary energies.',
    90,
    3100.00,
    'https://images.unsplash.com/photo-1609358905581-e5382c4731bd?w=400',
    ARRAY['Dosha Removal', 'Health and Longevity', 'Family Harmony'],
    true,
    true
),
(
    '10000000-0000-0000-0000-000000000003',
    'Rudrabhishek Pooja',
    'rudrabhishek-pooja',
    'Lord Shiva sacred abhishek for overcoming health issues and negative energies.',
    60,
    2500.00,
    'https://images.unsplash.com/photo-1567591974584-f1832d98c6a3?w=400',
    ARRAY['Health and Healing', 'Mental Peace', 'Negative Energy Protection'],
    true,
    true
)
ON CONFLICT (id) DO NOTHING;

-- Seed Coupons
INSERT INTO coupons (id, code, description, discount_type, discount_value, min_order_amount, max_discount_amount, valid_from, valid_until, is_active)
VALUES (
    '20000000-0000-0000-0000-000000000001',
    'ASTRO50',
    '50% discount up to ₹100 on your first consultation',
    'percentage',
    50.00,
    100.00,
    100.00,
    NOW() - INTERVAL '1 day',
    NOW() + INTERVAL '1 year',
    true
) ON CONFLICT (id) DO NOTHING;
