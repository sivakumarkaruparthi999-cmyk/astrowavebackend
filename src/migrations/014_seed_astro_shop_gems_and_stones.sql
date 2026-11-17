-- ==============================================================================
-- 014_seed_astro_shop_gems_and_stones.sql
-- Authentic Astrological Gemstones, Planetary Stones, Rudraksha & Yantras
-- ==============================================================================

-- Ensure category column exists
ALTER TABLE pooja_services ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'Pooja';

-- Insert Astrological Gemstones and Planetary Stones recommended by astrologers
INSERT INTO pooja_services (id, name, slug, description, category, duration_minutes, price, image_url, benefits, samagri_included, is_active)
VALUES
(
    '30000000-0000-0000-0000-000000000001',
    'Natural Yellow Sapphire (Pukhraj) - Lab Certified',
    'natural-yellow-sapphire-pukhraj',
    'Vedic Astrologer Recommended for Jupiter (Guru). Enhances financial abundance, marriage harmony, higher intellect, and spiritual wisdom. Consecrated with Brihaspati Vedic Mantras.',
    'Gemstones',
    7500,
    4500.00,
    'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Jupiter (Brihaspati)', 'Recommended for Sagittarius & Pisces', 'Brings Wealth & Marriage Blessings', '100% Lab Certified with Energisation'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000002',
    'Royal Blue Sapphire (Neelam) - Certified Natural',
    'royal-blue-sapphire-neelam',
    'Vedic Astrologer Recommended for Saturn (Shani Dev). Bestows rapid career breakthroughs, immense wealth, mental discipline, and karmic protection against Shani Sade Sati hurdles.',
    'Gemstones',
    9999,
    5999.00,
    'https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Saturn (Shani)', 'Recommended for Capricorn & Aquarius', 'Shields against Sade Sati & Evil Eye', 'Includes Shani Shanti Vedic Consecration'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000003',
    'Natural Burmese Ruby (Manikya) - Astrologer Certified',
    'natural-burmese-ruby-manikya',
    'Vedic Astrologer Recommended for Sun (Surya Dev). Enhances leadership charisma, government prestige, executive authority, vitality, and paternal blessings.',
    'Gemstones',
    6500,
    3999.00,
    'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Sun (Surya)', 'Recommended for Leo (Simha)', 'Vitality, Leadership & Government Success', 'Consecrated with Gayatri & Surya Mantras'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000004',
    'Natural Zambian Emerald (Panna) - Certified Grade',
    'natural-zambian-emerald-panna',
    'Vedic Astrologer Recommended for Mercury (Budh). Expands mental agility, sharp analytical intelligence, speech eloquence, stock trade profits, and creative commerce.',
    'Gemstones',
    5800,
    3499.00,
    'https://images.unsplash.com/photo-1611591475152-473523dd66c8?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Mercury (Budh)', 'Recommended for Gemini & Virgo', 'Elevates Business Acumen & Speech', 'Energised during Budha Hora'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000005',
    'Italian Red Coral (Moonga) - Mangal Dosha Remedy',
    'italian-red-coral-moonga',
    'Vedic Astrologer Recommended for Mars (Mangal Dev). Powerful astrological antidote for Manglik Dosha, cowardice, low hemoglobin, and land/property obstacles.',
    'Gemstones',
    4200,
    2499.00,
    'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Mars (Mangal)', 'Recommended for Aries & Scorpio', 'Neutralizes Mangal Dosha', 'Boosts Courage, Stamina & Real Estate Gains'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000006',
    'Natural South Sea Pearl (Moti) - Chandra Shanti',
    'natural-south-sea-pearl-moti',
    'Vedic Astrologer Recommended for Moon (Chandra). Calms the emotional mind, dispels depression and anger, restores harmonious relationships, and balances water element.',
    'Gemstones',
    3200,
    1899.00,
    'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Moon (Chandra)', 'Recommended for Cancer (Kark)', 'Emotional Harmony & Sound Sleep', 'Chandra Beej Mantra Energised'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000007',
    'Ceylon Hessonite Garnet (Gomed) - Rahu Protective Gem',
    'ceylon-hessonite-garnet-gomed',
    'Vedic Astrologer Recommended for Rahu. Shields seekers against sudden unforeseen adversities, conspiracy, evil eye, and mental fog. Accelerates unexpected wealth.',
    'Gemstones',
    3800,
    2199.00,
    'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Rahu', 'Antidote for Rahu Mahadasha & Antardasha', 'Protects from Sudden Calamities', 'Certified Natural Honey Color Stone'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000008',
    'Chrysoberyl Cat''s Eye (Lehsuniya) - Ketu Liberation Stone',
    'chrysoberyl-cats-eye-lehsuniya',
    'Vedic Astrologer Recommended for Ketu. Awakens inner spiritual intuition, sharp sixth sense, mystical protection, and liberation from chronic debt and hidden foes.',
    'Gemstones',
    3900,
    2299.00,
    'https://images.unsplash.com/photo-1567696911980-2eed69a46042?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Ketu', 'Enhances Intuition & Spiritual Sight', 'Deflects Black Magic & Envy', 'Clear Chatoyant Light Ray'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000009',
    'Natural White Zircon (Shukra Ratna) - Luxury & Charisma',
    'natural-white-zircon-shukra',
    'Vedic Astrologer Recommended for Venus (Shukra). Diamond astrological alternative that activates sensual charm, luxury cars, art aesthetics, and loving marriage compatibility.',
    'Gemstones',
    4500,
    2799.00,
    'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Venus (Shukra)', 'Recommended for Taurus & Libra', 'Attracts Luxury & Marital Romance', 'Brilliant Diamond Luster'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000010',
    'Raw Pyrite Golden Wealth Cluster - Money Magnet',
    'raw-pyrite-golden-wealth-cluster',
    'Astrologer Recommended Stone for Office & Cash Box. Radiates solar abundance, repels financial stagnation, and attracts prosperity opportunities.',
    'Crystals',
    1800,
    999.00,
    'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&auto=format&fit=crop&q=80',
    ARRAY['Solar Chakra & Wealth Attraction', 'Place in Cash Drawer or Work Desk', 'Natural Untreated Golden Mineral Cluster', 'Laxmi Puja Energised'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000011',
    'Natural Amethyst Crystal Cluster (Katela) - Peace & Focus',
    'natural-amethyst-crystal-cluster',
    'Astrologer Recommended Saturn Uparatna. Cleanses negative vibrations, relieves tension, deepens meditation, and dispels insomnia.',
    'Crystals',
    2199,
    1199.00,
    'https://images.unsplash.com/photo-1567696911980-2eed69a46042?w=600&auto=format&fit=crop&q=80',
    ARRAY['Saturn (Shani) Uparatna', 'Crown & Third Eye Chakra', 'Deep Calm & Addiction Relief', 'Deep Violet Natural Geode'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000012',
    'Natural Citrine Abundance Stone (Sunela) - Merchant Stone',
    'natural-citrine-abundance-stone',
    'Astrologer Recommended Jupiter Uparatna. The ultimate stone of business expansion, mental clarity, and joy. Never accumulates negative energy.',
    'Crystals',
    1600,
    799.00,
    'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80',
    ARRAY['Jupiter (Guru) Uparatna', 'The Merchant''s Prosperity Stone', 'Solar Plexus Activation', '100% Natural Golden Glow'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000013',
    '5-Mukhi Authentic Rudraksha Japa Mala (108+1 Beads)',
    '5-mukhi-authentic-rudraksha-japa-mala',
    'Vedic Astrologer Recommended Sacred Seed Mala. Ruled by Kalagni Rudra, helps regulate blood pressure, promotes equanimity, and dissolves past karmas.',
    'Rudraksha',
    1200,
    599.00,
    'https://images.unsplash.com/photo-1602173574767-37ac01994b2a?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Lord Shiva', '108+1 Certified Indonesian Seeds', 'Mahamrityunjaya Consecrated', 'Daily Japa & Wearing'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000014',
    '7-Mukhi Mahalaxmi Certified Rudraksha Pendant',
    '7-mukhi-mahalaxmi-certified-rudraksha',
    'Vedic Astrologer Recommended for Removing Poverty & Financial Stagnation. Ruled by Goddess Lakshmi, grants continuous wealth, good luck, and health.',
    'Rudraksha',
    1700,
    899.00,
    'https://images.unsplash.com/photo-1602173574767-37ac01994b2a?w=600&auto=format&fit=crop&q=80',
    ARRAY['Ruled by Goddess Lakshmi', 'Cures Shani & Financial Afflictions', 'Silver Capped Pendant', 'Lab Certified with X-Ray Report'],
    true,
    true
),
(
    '30000000-0000-0000-0000-000000000015',
    'Shree Sampoorna Maha Laxmi Yantra - Gold Plated',
    'shree-sampoorna-maha-laxmi-yantra',
    'Sacred Geometric Cosmic Energy Plate uniting 13 powerful prosperity yantras in one. Consecrated by Vedic Pandits for business premises and puja altars.',
    'Yantras',
    2400,
    1199.00,
    'https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&auto=format&fit=crop&q=80',
    ARRAY['13 Divine Prosperity Yantras', 'Deep Etched Pure Copper with 24K Gold Polish', 'Consecrated by Vedic Priests', 'For Home Altar, Shop & Office'],
    true,
    true
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    duration_minutes = EXCLUDED.duration_minutes,
    price = EXCLUDED.price,
    image_url = EXCLUDED.image_url,
    benefits = EXCLUDED.benefits,
    samagri_included = EXCLUDED.samagri_included,
    is_active = EXCLUDED.is_active;
