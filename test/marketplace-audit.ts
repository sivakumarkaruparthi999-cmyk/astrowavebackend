import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';

async function runMarketplaceAudit() {
  const timestamp = Date.now();
  const testAstroEmail = `audit.astrologer.${timestamp}@astro.com`;
  const testAstroPhone = `+9199${String(timestamp).slice(-8)}`;
  const testAstroName = `Acharya Audit ${timestamp}`;
  const testPassword = 'Password123!';

  console.log('===============================================================');
  console.log('PHASE 1 & 2: FRESH ASTROLOGER REGISTRATION');
  console.log('===============================================================');
  console.log(`Registering new astrologer: ${testAstroEmail} (${testAstroName})`);

  const regRes = await fetch('http://localhost:5001/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: testAstroEmail,
      phone: testAstroPhone,
      password: testPassword,
      fullName: testAstroName,
      role: 'astrologer'
    })
  });

  const regData = await regRes.json();
  console.log('Registration HTTP Status:', regRes.status);
  console.log('Registration Response:', JSON.stringify(regData));

  if (!regRes.ok || !regData.data?.user?.id) {
    throw new Error(`Astrologer registration failed: ${JSON.stringify(regData)}`);
  }

  const astroUserId = regData.data.user.id;
  console.log(`Registered Astrologer User ID: ${astroUserId}`);

  // Query PostgreSQL directly
  console.log('\n--- PostgreSQL Verification after Registration ---');
  const userRow = await queryPostgresSingle('SELECT id, email, phone, role, status, is_verified, created_at FROM users WHERE id = $1', [astroUserId]);
  console.log('users row:', JSON.stringify(userRow));

  const profileRow = await queryPostgresSingle('SELECT id, full_name FROM profiles WHERE id = $1', [astroUserId]);
  console.log('profiles row:', JSON.stringify(profileRow));

  const astroProfileRow = await queryPostgresSingle('SELECT id, display_name, per_minute_rate, is_verified, verification_status, is_online FROM astrologer_profiles WHERE id = $1', [astroUserId]);
  console.log('astrologer_profiles row:', JSON.stringify(astroProfileRow));

  console.log('\n===============================================================');
  console.log('PHASE 10: USER MARKETPLACE VISIBILITY (PRE-APPROVAL)');
  console.log('===============================================================');
  const marketPreRes = await fetch('http://localhost:5001/api/astrologers');
  const marketPreData = await marketPreRes.json();
  const foundPre = marketPreData.data?.find((a: any) => a.id === astroUserId);
  console.log(`Is pending astrologer visible in public marketplace before approval? ${foundPre ? 'YES (UNEXPECTED)' : 'NO (CORRECT: HIDDEN)'}`);

  console.log('\n===============================================================');
  console.log('PHASE 3: ADMIN PORTAL VISIBILITY');
  console.log('===============================================================');
  // Admin login
  const adminLoginRes = await fetch('http://localhost:5001/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@astro.com',
      password: 'Admin@123'
    })
  });
  const adminLoginData = await adminLoginRes.json();
  const adminToken = adminLoginData.data?.accessToken;
  console.log('Admin login status:', adminLoginRes.status, 'Token received:', !!adminToken);

  const adminListRes = await fetch('http://localhost:5001/api/admin/astrologers', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const adminListData = await adminListRes.json();
  const foundInAdmin = adminListData.data?.find((a: any) => a.id === astroUserId);
  console.log('Found in Admin List:', JSON.stringify(foundInAdmin));

  console.log('\n===============================================================');
  console.log('PHASE 9: APPROVAL SECURITY VERIFICATION');
  console.log('===============================================================');
  // Test 1: Unauthenticated approval
  const unauthRes = await fetch(`http://localhost:5001/api/admin/astrologers/${astroUserId}/verify`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isVerified: true, status: 'approved' })
  });
  console.log('Unauthenticated approval attempt status (Expected 401):', unauthRes.status);

  // Test 2: Astrologer attempting to approve themselves
  const astroToken = regData.data.accessToken;
  const selfApproveRes = await fetch(`http://localhost:5001/api/admin/astrologers/${astroUserId}/verify`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${astroToken}`
    },
    body: JSON.stringify({ isVerified: true, status: 'approved' })
  });
  console.log('Astrologer self-approval attempt status (Expected 403):', selfApproveRes.status);

  console.log('\n===============================================================');
  console.log('PHASE 4: ADMIN APPROVAL VIA ADMIN API');
  console.log('===============================================================');
  const approveRes = await fetch(`http://localhost:5001/api/admin/astrologers/${astroUserId}/verify`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ isVerified: true, status: 'approved' })
  });
  const approveData = await approveRes.json();
  console.log('Admin approval response status:', approveRes.status, JSON.stringify(approveData));

  // Query PostgreSQL directly
  console.log('\n--- PostgreSQL Verification after Admin Approval ---');
  const userRowPost = await queryPostgresSingle('SELECT id, is_verified, status FROM users WHERE id = $1', [astroUserId]);
  console.log('users row post-approval:', JSON.stringify(userRowPost));

  const astroProfileRowPost = await queryPostgresSingle('SELECT id, is_verified, verification_status FROM astrologer_profiles WHERE id = $1', [astroUserId]);
  console.log('astrologer_profiles row post-approval:', JSON.stringify(astroProfileRowPost));

  console.log('\n===============================================================');
  console.log('PHASE 5: USER MARKETPLACE VISIBILITY (POST-APPROVAL)');
  console.log('===============================================================');
  const marketPostRes = await fetch('http://localhost:5001/api/astrologers');
  const marketPostData = await marketPostRes.json();
  const foundPost = marketPostData.data?.find((a: any) => a.id === astroUserId);
  console.log('Approved Astrologer visible in marketplace:', JSON.stringify(foundPost));

  console.log('\n===============================================================');
  console.log('PHASE 6: CUSTOMER SELECTS ASTROLOGER & CREATES CONSULTATION');
  console.log('===============================================================');
  // Register or use customer with wallet balance
  const customerEmail = `audit.customer.${timestamp}@astro.com`;
  const custRegRes = await fetch('http://localhost:5001/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: customerEmail,
      password: testPassword,
      fullName: `Customer ${timestamp}`,
      role: 'customer'
    })
  });
  const custRegData = await custRegRes.json();
  const customerId = custRegData.data.user.id;
  const customerToken = custRegData.data.accessToken;

  // Add wallet balance for customer
  await queryPostgres('UPDATE wallets SET balance = 1000.00 WHERE user_id = $1', [customerId]);
  console.log(`Customer ${customerId} funded with ₹1000.00 wallet balance`);

  // Request consultation
  const consultRes = await fetch('http://localhost:5001/api/consultations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`
    },
    body: JSON.stringify({
      astrologerId: astroUserId,
      type: 'chat'
    })
  });
  const consultData = await consultRes.json();
  console.log('Consultation creation response status:', consultRes.status, JSON.stringify(consultData));

  const consultId = consultData.data?.id;
  const consultDb = await queryPostgresSingle('SELECT * FROM consultations WHERE id = $1', [consultId]);
  console.log('Consultation record in PostgreSQL:', JSON.stringify(consultDb));

  console.log('\n===============================================================');
  console.log('PHASE 7 & 8: DATABASE INTEGRITY & IDENTITY TRACING');
  console.log('===============================================================');
  const dupUsers = await queryPostgres('SELECT id, email, count(*) FROM users WHERE email = $1 GROUP BY id, email', [testAstroEmail]);
  const dupAstroProfiles = await queryPostgres('SELECT id, count(*) FROM astrologer_profiles WHERE id = $1 GROUP BY id', [astroUserId]);
  const orphanedProfiles = await queryPostgres('SELECT ap.id FROM astrologer_profiles ap LEFT JOIN users u ON ap.id = u.id WHERE u.id IS NULL');

  console.log('Duplicate users count:', dupUsers.length);
  console.log('Duplicate astrologer_profiles count:', dupAstroProfiles.length);
  console.log('Orphaned astrologer_profiles count:', orphanedProfiles.length);
  console.log('Identity matches across all tables:', (userRow.id === astroUserId && astroProfileRow.id === astroUserId && consultDb.astrologer_id === astroUserId && consultDb.user_id === customerId));

  console.log('\nAUDIT COMPLETE.');
  process.exit(0);
}

runMarketplaceAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
