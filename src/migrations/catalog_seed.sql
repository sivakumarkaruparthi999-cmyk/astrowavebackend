-- ==============================================================================
-- catalog_seed.sql - Production Initial Catalog Data (No Demo/Test Users)
-- ==============================================================================

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

-- Seed Base Promotional Coupons
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
    NOW() + INTERVAL '10 years',
    true
)
ON CONFLICT (id) DO NOTHING;
