-- ==============================================================================
-- 013_seed_astrologers.sql - Seed Live Astrologer Profiles into Database
-- ==============================================================================

-- 1. Pt. Javed Sayed
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    'deecc343-302f-41a2-8aa0-d2a5509dc1bd',
    'astrologer.javed@astrowave.it.com',
    '+919800000001',
    '$2b$10$T3CbQtGApx9ziyK/JEOrHewgCWvZTWFFou4jnP6GUL9XkO4kRbZ6C',
    'astrologer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    role = 'astrologer',
    status = 'active',
    is_verified = true;

INSERT INTO profiles (id, full_name, bio, created_at)
VALUES (
    'deecc343-302f-41a2-8aa0-d2a5509dc1bd',
    'Pt. Javed Sayed',
    'Senior Vedic Astrologer, Vastu Expert & Kundli Specialist with deep planetary analysis expertise.',
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    full_name = 'Pt. Javed Sayed',
    bio = 'Senior Vedic Astrologer, Vastu Expert & Kundli Specialist with deep planetary analysis expertise.';

INSERT INTO astrologer_profiles (
    id, display_name, bio, experience_years, hourly_rate, per_minute_rate,
    is_verified, verification_status, is_online, is_busy, rating, total_reviews, total_consultations,
    languages, specializations
) VALUES (
    'deecc343-302f-41a2-8aa0-d2a5509dc1bd',
    'Pt. Javed Sayed',
    'Senior Vedic Astrologer, Vastu Expert & Kundli Specialist with deep planetary analysis expertise.',
    12,
    1500.00,
    25.00,
    true,
    'approved',
    true,
    false,
    5.00,
    420,
    1250,
    ARRAY['English', 'Hindi', 'Urdu'],
    ARRAY['Vedic', 'Kundli', 'Numerology', 'Career & Wealth']
) ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    bio = EXCLUDED.bio,
    experience_years = EXCLUDED.experience_years,
    hourly_rate = EXCLUDED.hourly_rate,
    per_minute_rate = EXCLUDED.per_minute_rate,
    is_verified = true,
    verification_status = 'approved',
    is_online = EXCLUDED.is_online,
    rating = EXCLUDED.rating,
    total_reviews = EXCLUDED.total_reviews,
    total_consultations = EXCLUDED.total_consultations,
    languages = EXCLUDED.languages,
    specializations = EXCLUDED.specializations;

-- 2. Acharya Aditya Sharma
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    'f7d44301-df84-477f-a4c2-e080768d378c',
    'astrologer.aditya@astrowave.it.com',
    '+919800000002',
    '$2b$10$T3CbQtGApx9ziyK/JEOrHewgCWvZTWFFou4jnP6GUL9XkO4kRbZ6C',
    'astrologer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    role = 'astrologer',
    status = 'active',
    is_verified = true;

INSERT INTO profiles (id, full_name, bio, created_at)
VALUES (
    'f7d44301-df84-477f-a4c2-e080768d378c',
    'Acharya Aditya Sharma',
    'Renowned Prashna Kundli, Vedic Marriage compatibility & Love Relationship counselor.',
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    full_name = 'Acharya Aditya Sharma',
    bio = 'Renowned Prashna Kundli, Vedic Marriage compatibility & Love Relationship counselor.';

INSERT INTO astrologer_profiles (
    id, display_name, bio, experience_years, hourly_rate, per_minute_rate,
    is_verified, verification_status, is_online, is_busy, rating, total_reviews, total_consultations,
    languages, specializations
) VALUES (
    'f7d44301-df84-477f-a4c2-e080768d378c',
    'Acharya Aditya Sharma',
    'Renowned Prashna Kundli, Vedic Marriage compatibility & Love Relationship counselor.',
    15,
    1800.00,
    30.00,
    true,
    'approved',
    true,
    false,
    4.90,
    890,
    2400,
    ARRAY['Hindi', 'Sanskrit', 'English'],
    ARRAY['Vedic', 'Marriage', 'Love & Relationship', 'Kundli']
) ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    bio = EXCLUDED.bio,
    experience_years = EXCLUDED.experience_years,
    hourly_rate = EXCLUDED.hourly_rate,
    per_minute_rate = EXCLUDED.per_minute_rate,
    is_verified = true,
    verification_status = 'approved',
    is_online = EXCLUDED.is_online,
    rating = EXCLUDED.rating,
    total_reviews = EXCLUDED.total_reviews,
    total_consultations = EXCLUDED.total_consultations,
    languages = EXCLUDED.languages,
    specializations = EXCLUDED.specializations;

-- 3. Tarot Reader Meera
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    '903ddb5f-cf6c-492a-90f0-e3cd330d9b17',
    'astrologer.meera@astrowave.it.com',
    '+919800000003',
    '$2b$10$T3CbQtGApx9ziyK/JEOrHewgCWvZTWFFou4jnP6GUL9XkO4kRbZ6C',
    'astrologer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    role = 'astrologer',
    status = 'active',
    is_verified = true;

INSERT INTO profiles (id, full_name, bio, created_at)
VALUES (
    '903ddb5f-cf6c-492a-90f0-e3cd330d9b17',
    'Tarot Reader Meera',
    'Intuitive Tarot Master, Angel Card Healer and Crystal Energy Consultant.',
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    full_name = 'Tarot Reader Meera',
    bio = 'Intuitive Tarot Master, Angel Card Healer and Crystal Energy Consultant.';

INSERT INTO astrologer_profiles (
    id, display_name, bio, experience_years, hourly_rate, per_minute_rate,
    is_verified, verification_status, is_online, is_busy, rating, total_reviews, total_consultations,
    languages, specializations
) VALUES (
    '903ddb5f-cf6c-492a-90f0-e3cd330d9b17',
    'Tarot Reader Meera',
    'Intuitive Tarot Master, Angel Card Healer and Crystal Energy Consultant.',
    8,
    1200.00,
    20.00,
    true,
    'approved',
    true,
    false,
    4.80,
    310,
    950,
    ARRAY['English', 'Hindi'],
    ARRAY['Tarot', 'Love & Relationship', 'Career & Wealth']
) ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    bio = EXCLUDED.bio,
    experience_years = EXCLUDED.experience_years,
    hourly_rate = EXCLUDED.hourly_rate,
    per_minute_rate = EXCLUDED.per_minute_rate,
    is_verified = true,
    verification_status = 'approved',
    is_online = EXCLUDED.is_online,
    rating = EXCLUDED.rating,
    total_reviews = EXCLUDED.total_reviews,
    total_consultations = EXCLUDED.total_consultations,
    languages = EXCLUDED.languages,
    specializations = EXCLUDED.specializations;

-- 4. Dr. Raman Shastri
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    '5dadadc0-f71a-4d44-adfd-5587612bdfcb',
    'astrologer.raman@astrowave.it.com',
    '+919800000004',
    '$2b$10$T3CbQtGApx9ziyK/JEOrHewgCWvZTWFFou4jnP6GUL9XkO4kRbZ6C',
    'astrologer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    role = 'astrologer',
    status = 'active',
    is_verified = true;

INSERT INTO profiles (id, full_name, bio, created_at)
VALUES (
    '5dadadc0-f71a-4d44-adfd-5587612bdfcb',
    'Dr. Raman Shastri',
    'PhD in Jyotish Vidya, specialist in Kaal Sarp & Manglik Dosha remedies.',
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    full_name = 'Dr. Raman Shastri',
    bio = 'PhD in Jyotish Vidya, specialist in Kaal Sarp & Manglik Dosha remedies.';

INSERT INTO astrologer_profiles (
    id, display_name, bio, experience_years, hourly_rate, per_minute_rate,
    is_verified, verification_status, is_online, is_busy, rating, total_reviews, total_consultations,
    languages, specializations
) VALUES (
    '5dadadc0-f71a-4d44-adfd-5587612bdfcb',
    'Dr. Raman Shastri',
    'PhD in Jyotish Vidya, specialist in Kaal Sarp & Manglik Dosha remedies.',
    20,
    2400.00,
    40.00,
    true,
    'approved',
    true,
    false,
    5.00,
    1450,
    4100,
    ARRAY['Hindi', 'English', 'Gujarati'],
    ARRAY['Vedic', 'Kundli', 'Vastu', 'Marriage']
) ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    bio = EXCLUDED.bio,
    experience_years = EXCLUDED.experience_years,
    hourly_rate = EXCLUDED.hourly_rate,
    per_minute_rate = EXCLUDED.per_minute_rate,
    is_verified = true,
    verification_status = 'approved',
    is_online = EXCLUDED.is_online,
    rating = EXCLUDED.rating,
    total_reviews = EXCLUDED.total_reviews,
    total_consultations = EXCLUDED.total_consultations,
    languages = EXCLUDED.languages,
    specializations = EXCLUDED.specializations;

-- 5. Numerologist Priya Kapoor
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    'b1c2dc67-988a-4b84-bb5e-5cf62b5aa523',
    'astrologer.priya@astrowave.it.com',
    '+919800000005',
    '$2b$10$T3CbQtGApx9ziyK/JEOrHewgCWvZTWFFou4jnP6GUL9XkO4kRbZ6C',
    'astrologer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    role = 'astrologer',
    status = 'active',
    is_verified = true;

INSERT INTO profiles (id, full_name, bio, created_at)
VALUES (
    'b1c2dc67-988a-4b84-bb5e-5cf62b5aa523',
    'Numerologist Priya Kapoor',
    'Name correction, Business numerology, and destiny matrix specialist.',
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    full_name = 'Numerologist Priya Kapoor',
    bio = 'Name correction, Business numerology, and destiny matrix specialist.';

INSERT INTO astrologer_profiles (
    id, display_name, bio, experience_years, hourly_rate, per_minute_rate,
    is_verified, verification_status, is_online, is_busy, rating, total_reviews, total_consultations,
    languages, specializations
) VALUES (
    'b1c2dc67-988a-4b84-bb5e-5cf62b5aa523',
    'Numerologist Priya Kapoor',
    'Name correction, Business numerology, and destiny matrix specialist.',
    9,
    1500.00,
    25.00,
    true,
    'approved',
    true,
    false,
    4.90,
    520,
    1600,
    ARRAY['English', 'Hindi', 'Punjabi'],
    ARRAY['Numerology', 'Career & Wealth', 'Tarot']
) ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    bio = EXCLUDED.bio,
    experience_years = EXCLUDED.experience_years,
    hourly_rate = EXCLUDED.hourly_rate,
    per_minute_rate = EXCLUDED.per_minute_rate,
    is_verified = true,
    verification_status = 'approved',
    is_online = EXCLUDED.is_online,
    rating = EXCLUDED.rating,
    total_reviews = EXCLUDED.total_reviews,
    total_consultations = EXCLUDED.total_consultations,
    languages = EXCLUDED.languages,
    specializations = EXCLUDED.specializations;

-- 6. Pandit Radhe Mohan
INSERT INTO users (id, email, phone, password_hash, role, status, is_verified, created_at)
VALUES (
    '9a68ac9f-fd01-4f29-be64-fa10f87cc7ec',
    'astrologer.radhe@astrowave.it.com',
    '+919800000006',
    '$2b$10$T3CbQtGApx9ziyK/JEOrHewgCWvZTWFFou4jnP6GUL9XkO4kRbZ6C',
    'astrologer',
    'active',
    true,
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    role = 'astrologer',
    status = 'active',
    is_verified = true;

INSERT INTO profiles (id, full_name, bio, created_at)
VALUES (
    '9a68ac9f-fd01-4f29-be64-fa10f87cc7ec',
    'Pandit Radhe Mohan',
    'Specialist in Muhurat, Griha Pravesh, Vedic Pooja ritual counseling.',
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    full_name = 'Pandit Radhe Mohan',
    bio = 'Specialist in Muhurat, Griha Pravesh, Vedic Pooja ritual counseling.';

INSERT INTO astrologer_profiles (
    id, display_name, bio, experience_years, hourly_rate, per_minute_rate,
    is_verified, verification_status, is_online, is_busy, rating, total_reviews, total_consultations,
    languages, specializations
) VALUES (
    '9a68ac9f-fd01-4f29-be64-fa10f87cc7ec',
    'Pandit Radhe Mohan',
    'Specialist in Muhurat, Griha Pravesh, Vedic Pooja ritual counseling.',
    14,
    1500.00,
    25.00,
    true,
    'approved',
    false,
    false,
    4.70,
    260,
    780,
    ARRAY['Hindi', 'Sanskrit'],
    ARRAY['Vedic', 'Vastu', 'Marriage']
) ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    bio = EXCLUDED.bio,
    experience_years = EXCLUDED.experience_years,
    hourly_rate = EXCLUDED.hourly_rate,
    per_minute_rate = EXCLUDED.per_minute_rate,
    is_verified = true,
    verification_status = 'approved',
    is_online = EXCLUDED.is_online,
    rating = EXCLUDED.rating,
    total_reviews = EXCLUDED.total_reviews,
    total_consultations = EXCLUDED.total_consultations,
    languages = EXCLUDED.languages,
    specializations = EXCLUDED.specializations;
