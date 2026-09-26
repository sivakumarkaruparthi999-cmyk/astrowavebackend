import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { queryPostgres, queryPostgresSingle, connectMongo, pgPool } from '../src/config/db.js';
import { AstrologyEngineService } from '../src/services/astrology.service.js';
import { ChatMessage } from '../src/models/mongo/ChatMessage.js';
import { ChatConversation } from '../src/models/mongo/ChatConversation.js';

const BASE_URL = 'http://localhost:5001/api';
const HTTP_TIMEOUT_MS = 5000;

/**
 * Robust fetch helper with timeout to ensure audit never hangs indefinitely.
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`[Timeout] Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Global audit state
let customerToken = '';
let customerRefreshToken = '';
let customerId = '';
const testEmail = `audit_cust_${Date.now()}@astrotalk.test`;
const testPassword = 'AuditPassword@123';

let astrologerToken = '';
let astrologerId = '';

let adminToken = '';
let adminId = '';

let consultationId = '';

test.before(async () => {
  console.log('[AUDIT:SETUP] Initializing database connections for validation...');
  await connectMongo();
  console.log('[AUDIT:SETUP] MongoDB connected.');
});

test.after(async () => {
  console.log('[AUDIT:CLEANUP] Closing database connections and releasing handles...');
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log('[AUDIT:CLEANUP] MongoDB disconnected.');
    }
    if (!pgPool.ended) {
      await pgPool.end();
      console.log('[AUDIT:CLEANUP] PostgreSQL pool closed.');
    }
  } catch (err) {
    console.error('[AUDIT:CLEANUP] Error during cleanup:', err);
  }
  console.log('[AUDIT:CLEANUP] All handles cleanly released.');
});

test('1. Health API & Database Connectivity', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] Checking GET /api/health...');
  const healthRes = await fetchWithTimeout('http://localhost:5001/api/health');
  assert.equal(healthRes.status, 200, `Health API returned HTTP ${healthRes.status}`);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.status, 'ok');
  assert.equal(healthJson.databases.postgres, true, 'PostgreSQL must be connected');
  assert.equal(healthJson.databases.mongo, true, 'MongoDB must be connected');
  console.log('[AUDIT:DIAGNOSTIC] Health API passed with PostgreSQL and MongoDB healthy.');
});

test('2. User Authentication & Profile Lifecycle', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 2.1 Registering new customer...');
  const regRes = await fetchWithTimeout(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      fullName: 'Audit Seeker User',
      phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
      role: 'customer',
    }),
  });
  const regJson = await regRes.json();
  assert.equal(regRes.status, 201, `Register failed: ${JSON.stringify(regJson)}`);
  assert.equal(regJson.success, true);
  assert.ok(regJson.data.accessToken, 'Access token missing in registration');
  assert.ok(regJson.data.refreshToken, 'Refresh token missing in registration');
  customerId = regJson.data.user.id;
  customerToken = regJson.data.accessToken;
  customerRefreshToken = regJson.data.refreshToken;
  console.log('[AUDIT:DIAGNOSTIC] User registered successfully, ID:', customerId);

  console.log('[AUDIT:DIAGNOSTIC] 2.2 Invalid credentials verification...');
  const badLoginRes = await fetchWithTimeout(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: 'WrongPassword!999' }),
  });
  assert.equal(badLoginRes.status, 401, 'Bad credentials should return 401');

  console.log('[AUDIT:DIAGNOSTIC] 2.3 Valid login...');
  const loginRes = await fetchWithTimeout(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const loginJson = await loginRes.json();
  assert.equal(loginRes.status, 200);
  assert.equal(loginJson.success, true);
  assert.ok(loginJson.data.accessToken);

  console.log('[AUDIT:DIAGNOSTIC] 2.4 User profile retrieval (/auth/me)...');
  const meRes = await fetchWithTimeout(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const meJson = await meRes.json();
  assert.equal(meRes.status, 200);
  assert.equal(meJson.data.email, testEmail);

  console.log('[AUDIT:DIAGNOSTIC] 2.5 Update user profile...');
  const updateRes = await fetchWithTimeout(`${BASE_URL}/users/profile`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      gender: 'Male',
      placeOfBirth: 'Mumbai, Maharashtra',
      bio: 'Devoted spiritual seeker.',
    }),
  });
  const updateJson = await updateRes.json();
  assert.equal(updateRes.status, 200);
  assert.equal(updateJson.data.place_of_birth, 'Mumbai, Maharashtra');

  console.log('[AUDIT:DIAGNOSTIC] 2.6 Token refresh flow...');
  const refreshRes = await fetchWithTimeout(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: customerRefreshToken }),
  });
  const refreshJson = await refreshRes.json();
  assert.equal(refreshRes.status, 200);
  assert.ok(refreshJson.data.accessToken);
  customerToken = refreshJson.data.accessToken;
});

test('3. Astrologer Authentication & Workflows', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 3.1 Astrologer login...');
  const astroLoginRes = await fetchWithTimeout(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'astrologer@astro.com',
      password: 'Astro@123',
    }),
  });
  const astroLoginJson = await astroLoginRes.json();
  assert.equal(astroLoginRes.status, 200, `Astrologer login failed: ${JSON.stringify(astroLoginJson)}`);
  astrologerToken = astroLoginJson.data.accessToken;
  astrologerId = astroLoginJson.data.user.id;
  console.log('[AUDIT:DIAGNOSTIC] Astrologer logged in, ID:', astrologerId);

  console.log('[AUDIT:DIAGNOSTIC] 3.2 List Astrologers (Marketplace)...');
  const listRes = await fetchWithTimeout(`${BASE_URL}/astrologers`);
  const listJson = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.ok(listJson.data.length > 0, 'Astrologer list should contain at least 1 astrologer');

  console.log('[AUDIT:DIAGNOSTIC] 3.3 Astrologer detail inspection...');
  const astroDetailRes = await fetchWithTimeout(`${BASE_URL}/astrologers/${astrologerId}`);
  const astroDetailJson = await astroDetailRes.json();
  assert.equal(astroDetailRes.status, 200);
  assert.equal(astroDetailJson.data.id, astrologerId);

  console.log('[AUDIT:DIAGNOSTIC] 3.4 Update Astrologer status (Online/Rate)...');
  const statusRes = await fetchWithTimeout(`${BASE_URL}/astrologers/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${astrologerToken}`,
    },
    body: JSON.stringify({
      isOnline: true,
      perMinuteRate: 35.0,
    }),
  });
  const statusJson = await statusRes.json();
  assert.equal(statusRes.status, 200);
  assert.equal(Number(statusJson.data.per_minute_rate), 35.0);

  console.log('[AUDIT:DIAGNOSTIC] 3.5 Check Astrologer earnings...');
  const earningsRes = await fetchWithTimeout(`${BASE_URL}/astrologers/me/earnings`, {
    headers: { Authorization: `Bearer ${astrologerToken}` },
  });
  const earningsJson = await earningsRes.json();
  assert.equal(earningsRes.status, 200);
  assert.ok(earningsJson.data.earnings !== undefined);

  console.log('[AUDIT:DIAGNOSTIC] 3.6 Upload Astrologer KYC document...');
  const docRes = await fetchWithTimeout(`${BASE_URL}/astrologers/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${astrologerToken}`,
    },
    body: JSON.stringify({
      documentType: 'Aadhaar Card',
      documentUrl: 'http://localhost:5001/uploads/documents/test_aadhaar.pdf',
    }),
  });
  const docJson = await docRes.json();
  assert.equal(docRes.status, 201);
  assert.equal(docJson.data.document_type, 'Aadhaar Card');
});

test('4. Admin Management & RBAC Enforcement', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 4.1 Admin login...');
  const adminLoginRes = await fetchWithTimeout(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@astro.com',
      password: 'Admin@123',
    }),
  });
  const adminLoginJson = await adminLoginRes.json();
  assert.equal(adminLoginRes.status, 200, `Admin login failed: ${JSON.stringify(adminLoginJson)}`);
  adminToken = adminLoginJson.data.accessToken;
  adminId = adminLoginJson.data.user.id;
  console.log('[AUDIT:DIAGNOSTIC] Admin logged in, ID:', adminId);

  console.log('[AUDIT:DIAGNOSTIC] 4.2 Non-admin RBAC authorization barrier check...');
  const blockedRes = await fetchWithTimeout(`${BASE_URL}/admin/stats`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  assert.equal(blockedRes.status, 403, 'Customer should be forbidden from admin routes');

  console.log('[AUDIT:DIAGNOSTIC] 4.3 Admin Stats retrieval...');
  const statsRes = await fetchWithTimeout(`${BASE_URL}/admin/stats`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const statsJson = await statsRes.json();
  assert.equal(statsRes.status, 200);
  assert.ok(statsJson.data.totalUsers >= 1);
  assert.ok(statsJson.data.totalAstrologers >= 1);

  console.log('[AUDIT:DIAGNOSTIC] 4.4 Admin User Management List...');
  const usersRes = await fetchWithTimeout(`${BASE_URL}/admin/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const usersJson = await usersRes.json();
  assert.equal(usersRes.status, 200);
  assert.ok(usersJson.data.length >= 1);

  console.log('[AUDIT:DIAGNOSTIC] 4.5 Admin Astrologer Verification...');
  const verifyRes = await fetchWithTimeout(`${BASE_URL}/admin/astrologers/${astrologerId}/verify`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ isVerified: true, status: 'approved' }),
  });
  const verifyJson = await verifyRes.json();
  assert.equal(verifyRes.status, 200);

  console.log('[AUDIT:DIAGNOSTIC] 4.6 Admin Broadcast Notification...');
  const broadcastRes = await fetchWithTimeout(`${BASE_URL}/admin/notifications/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      title: 'Festival Auspicious Alert',
      body: 'Special Maha Shivratri pooja slots are now open.',
      targetRole: 'all',
    }),
  });
  const broadcastJson = await broadcastRes.json();
  assert.equal(broadcastRes.status, 200);
});

test('5. Wallet Recharge & Payment Verification', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 5.1 Check initial customer wallet...');
  const walletRes = await fetchWithTimeout(`${BASE_URL}/users/wallet`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const walletJson = await walletRes.json();
  assert.equal(walletRes.status, 200);

  console.log('[AUDIT:DIAGNOSTIC] 5.2 Create payment order...');
  const orderRes = await fetchWithTimeout(`${BASE_URL}/payments/create-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({ amount: 500.0, currency: 'INR' }),
  });
  const orderJson = await orderRes.json();
  assert.equal(orderRes.status, 200);
  assert.ok(orderJson.data.orderId);

  console.log('[AUDIT:DIAGNOSTIC] 5.3 Verify payment and credit wallet balance...');
  const verifyPayRes = await fetchWithTimeout(`${BASE_URL}/payments/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      orderId: orderJson.data.orderId,
      paymentId: `pay_test_${Date.now()}`,
      signature: 'mock_verified_signature',
    }),
  });
  const verifyPayJson = await verifyPayRes.json();
  assert.equal(verifyPayRes.status, 200);
  assert.ok(verifyPayJson.data.newBalance >= 500.0);

  console.log('[AUDIT:DIAGNOSTIC] 5.4 Check updated wallet balance & ledger...');
  const updatedWalletRes = await fetchWithTimeout(`${BASE_URL}/users/wallet`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const updatedWalletJson = await updatedWalletRes.json();
  assert.equal(updatedWalletRes.status, 200);
  assert.ok(updatedWalletJson.data.balance >= 500.0);
  assert.ok(updatedWalletJson.data.transactions.length >= 1);
});

test('6. Consultation Lifecycle & Settlement', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 6.1 Customer requests consultation...');
  const requestRes = await fetchWithTimeout(`${BASE_URL}/consultations/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      astrologerId,
      type: 'chat',
    }),
  });
  const requestJson = await requestRes.json();
  assert.equal(requestRes.status, 201);
  consultationId = requestJson.data.id;
  assert.equal(requestJson.data.state, 'REQUESTED');
  console.log('[AUDIT:DIAGNOSTIC] Consultation created, ID:', consultationId);

  console.log('[AUDIT:DIAGNOSTIC] 6.2 Astrologer accepts consultation...');
  const acceptRes = await fetchWithTimeout(`${BASE_URL}/consultations/${consultationId}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${astrologerToken}` },
  });
  const acceptJson = await acceptRes.json();
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptJson.data.state, 'ACCEPTED');

  console.log('[AUDIT:DIAGNOSTIC] 6.3 Astrologer ends & settles consultation...');
  const endRes = await fetchWithTimeout(`${BASE_URL}/consultations/${consultationId}/end`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${astrologerToken}`,
    },
    body: JSON.stringify({ durationSeconds: 300 }),
  });
  const endJson = await endRes.json();
  assert.equal(endRes.status, 200);
  assert.equal(endJson.data.state, 'ENDED');
  assert.ok(Number(endJson.data.total_amount) > 0);

  console.log('[AUDIT:DIAGNOSTIC] 6.4 Verify Customer Consultation History...');
  const historyRes = await fetchWithTimeout(`${BASE_URL}/consultations/history`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const historyJson = await historyRes.json();
  assert.equal(historyRes.status, 200);
  assert.ok(historyJson.data.some((c: any) => c.id === consultationId));
});

test('7. Chat & MongoDB Real-Time Document Operations', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 7.1 Customer sends chat message...');
  const sendRes = await fetchWithTimeout(`${BASE_URL}/chat/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      consultationId,
      recipientId: astrologerId,
      content: 'Namaste Guruji, please analyze my career chart.',
      messageType: 'text',
    }),
  });
  const sendJson = await sendRes.json();
  assert.equal(sendRes.status, 201);
  assert.equal(sendJson.data.content, 'Namaste Guruji, please analyze my career chart.');

  console.log('[AUDIT:DIAGNOSTIC] 7.2 Astrologer sends chat reply...');
  const replyRes = await fetchWithTimeout(`${BASE_URL}/chat/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${astrologerToken}`,
    },
    body: JSON.stringify({
      consultationId,
      recipientId: customerId,
      content: 'Pranam. Looking at your 10th house, Jupiter is highly auspicious.',
      messageType: 'text',
    }),
  });
  const replyJson = await replyRes.json();
  assert.equal(replyRes.status, 201);

  console.log('[AUDIT:DIAGNOSTIC] 7.3 Fetch consultation messages via API...');
  const listMsgRes = await fetchWithTimeout(`${BASE_URL}/chat/messages/${consultationId}`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const listMsgJson = await listMsgRes.json();
  assert.equal(listMsgRes.status, 200);
  assert.ok(listMsgJson.data.length >= 2);

  console.log('[AUDIT:DIAGNOSTIC] 7.4 MongoDB direct document validation...');
  const mongoCount = await ChatMessage.countDocuments({ consultationId });
  assert.ok(mongoCount >= 2, `Expected at least 2 Mongo messages, found ${mongoCount}`);

  const convoDoc = await ChatConversation.findOne({ consultationId });
  assert.ok(convoDoc !== null, 'ChatConversation document must exist in MongoDB');
});

test('8. Pooja Marketplace & Booking Flow', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 8.1 List Pooja catalog...');
  const poojaListRes = await fetchWithTimeout(`${BASE_URL}/pooja/services`);
  const poojaListJson = await poojaListRes.json();
  assert.equal(poojaListRes.status, 200);
  assert.ok(poojaListJson.data.length >= 1);
  const service = poojaListJson.data[0];

  console.log('[AUDIT:DIAGNOSTIC] 8.2 Get Pooja Service by slug...');
  const serviceRes = await fetchWithTimeout(`${BASE_URL}/pooja/services/${service.slug}`);
  const serviceJson = await serviceRes.json();
  assert.equal(serviceRes.status, 200);
  assert.equal(serviceJson.data.id, service.id);

  console.log('[AUDIT:DIAGNOSTIC] 8.3 Book Pooja with Sankalp details...');
  const bookRes = await fetchWithTimeout(`${BASE_URL}/pooja/book`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      poojaServiceId: service.id,
      bookingDate: '2026-10-15',
      bookingTime: '09:30 AM',
      address: 'B-104, Shanti Niketan',
      city: 'Varanasi',
      state: 'Uttar Pradesh',
      pincode: '221001',
      gotra: 'Kashyapa',
      nakshatra: 'Rohini',
      specialInstructions: 'Please include special Sankalp for family health.',
    }),
  });
  const bookJson = await bookRes.json();
  assert.equal(bookRes.status, 201);
  assert.equal(bookJson.data.pooja_service_id, service.id);

  console.log('[AUDIT:DIAGNOSTIC] 8.4 List Customer Pooja Bookings...');
  const userBookingsRes = await fetchWithTimeout(`${BASE_URL}/pooja/my-bookings`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const userBookingsJson = await userBookingsRes.json();
  assert.equal(userBookingsRes.status, 200);
  assert.ok(userBookingsJson.data.length >= 1);
});

test('9. Muhurat Engine & Calculation Orders', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 9.1 Calculate Panchang Muhurat...');
  const calcRes = await fetchWithTimeout(`${BASE_URL}/muhurat/calculate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-15',
      latitude: 28.6139,
      longitude: 77.2090,
    }),
  });
  const calcJson = await calcRes.json();
  assert.equal(calcRes.status, 200);
  assert.ok(calcJson.data.tithi, 'Panchang tithi must exist');
  assert.ok(calcJson.data.auspiciousWindows, 'Auspicious windows must exist');

  console.log('[AUDIT:DIAGNOSTIC] 9.2 Place Muhurat Order...');
  const orderRes = await fetchWithTimeout(`${BASE_URL}/muhurat/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      eventType: 'Griha Pravesh',
      eventName: 'New Home Entry Muhurat',
      startDate: '2026-11-01',
      endDate: '2026-11-15',
      place: 'Pune, Maharashtra',
      amount: 499.0,
    }),
  });
  const orderJson = await orderRes.json();
  assert.equal(orderRes.status, 201);
  assert.equal(orderJson.data.event_type, 'Griha Pravesh');

  console.log('[AUDIT:DIAGNOSTIC] 9.3 List Customer Muhurat Orders...');
  const listOrdersRes = await fetchWithTimeout(`${BASE_URL}/muhurat/my-orders`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const listOrdersJson = await listOrdersRes.json();
  assert.equal(listOrdersRes.status, 200);
  assert.ok(listOrdersJson.data.length >= 1);
});

test('10. Vedic Astrology Engine & Kundli Management', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 10.1 Generate Kundli Chart via Astrology Engine...');
  const kundliRes = await fetchWithTimeout(`${BASE_URL}/astrology/kundli/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Javed Sayed',
      gender: 'Male',
      birth_date: '2004-05-15',
      birth_time: '14:30',
      birth_place: 'Mumbai, India',
      latitude: 19.0760,
      longitude: 72.8777,
    }),
  });
  const kundliJson = await kundliRes.json();
  assert.equal(kundliRes.status, 200);
  assert.ok(kundliJson.data.lagna);
  assert.equal(Object.keys(kundliJson.data.planets).length, 9);
  assert.ok(kundliJson.data.charts.d1);
  assert.ok(kundliJson.data.dashas.timeline.length > 0);

  console.log('[AUDIT:DIAGNOSTIC] 10.2 Save Kundli Profile...');
  const saveKundliRes = await fetchWithTimeout(`${BASE_URL}/users/kundlis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      name: 'Javed Sayed',
      gender: 'Male',
      birthDate: '2004-05-15',
      birthTime: '14:30',
      birthPlace: 'Mumbai, India',
      latitude: 19.0760,
      longitude: 72.8777,
    }),
  });
  const saveKundliJson = await saveKundliRes.json();
  assert.equal(saveKundliRes.status, 201);
  assert.equal(saveKundliJson.data.name, 'Javed Sayed');

  console.log('[AUDIT:DIAGNOSTIC] 10.3 List Saved Kundlis...');
  const listKundlisRes = await fetchWithTimeout(`${BASE_URL}/users/kundlis`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const listKundlisJson = await listKundlisRes.json();
  assert.equal(listKundlisRes.status, 200);
  assert.ok(listKundlisJson.data.length >= 1);
});

test('11. Notifications Flow', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 11.1 List User Notifications...');
  const notifRes = await fetchWithTimeout(`${BASE_URL}/users/notifications`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const notifJson = await notifRes.json();
  assert.equal(notifRes.status, 200);
  assert.ok(Array.isArray(notifJson.data));

  console.log('[AUDIT:DIAGNOSTIC] 11.2 Mark all notifications read...');
  const markAllRes = await fetchWithTimeout(`${BASE_URL}/users/notifications/all/read`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  assert.equal(markAllRes.status, 200);
});

test('12. Payout Accounts & Management', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 12.1 Add Astrologer Bank Account...');
  const addAccRes = await fetchWithTimeout(`${BASE_URL}/payouts/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${astrologerToken}`,
    },
    body: JSON.stringify({
      accountType: 'bank_account',
      accountHolderName: 'Acharya Astrologer',
      accountNumber: '918273645544',
      ifscCode: 'HDFC0001234',
      upiId: 'acharya@okhdfcbank',
      isPrimary: true,
    }),
  });
  const addAccJson = await addAccRes.json();
  assert.equal(addAccRes.status, 201);

  console.log('[AUDIT:DIAGNOSTIC] 12.2 List Astrologer Payout Accounts...');
  const listAccRes = await fetchWithTimeout(`${BASE_URL}/payouts/accounts`, {
    headers: { Authorization: `Bearer ${astrologerToken}` },
  });
  const listAccJson = await listAccRes.json();
  assert.equal(listAccRes.status, 200);
  assert.ok(listAccJson.data.length >= 1);
});

test('13. Multipart File Upload & Static Storage', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 13.1 Upload file via multipart form-data...');
  const formData = new FormData();
  formData.append('file', new Blob(['test-binary-document-content'], { type: 'text/plain' }), 'audit_test_doc.txt');

  const uploadRes = await fetchWithTimeout(`${BASE_URL}/chat/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${customerToken}`,
    },
    body: formData,
  });
  const uploadJson = await uploadRes.json();
  assert.equal(uploadRes.status, 200, `File upload failed: ${JSON.stringify(uploadJson)}`);
  assert.ok(uploadJson.data.fileUrl);
  console.log('[AUDIT:DIAGNOSTIC] File uploaded successfully, URL:', uploadJson.data.fileUrl);

  console.log('[AUDIT:DIAGNOSTIC] 13.2 Verify static file accessibility...');
  const fileCheckRes = await fetchWithTimeout(uploadJson.data.fileUrl);
  assert.equal(fileCheckRes.status, 200, 'Uploaded file should be reachable statically');
});

test('14. Security, CORS & SQL Injection Protection', async (t) => {
  console.log('[AUDIT:DIAGNOSTIC] 14.1 Checking Helmet security headers...');
  const healthRes = await fetchWithTimeout('http://localhost:5001/api/health');
  assert.equal(healthRes.status, 200);
  const helmetHeader = healthRes.headers.get('x-content-type-options');
  assert.equal(helmetHeader, 'nosniff');

  console.log('[AUDIT:DIAGNOSTIC] 14.2 Testing SQL injection safety...');
  const sqlInjRes = await fetchWithTimeout(`${BASE_URL}/astrologers?search=' OR '1'='1`);
  assert.equal(sqlInjRes.status, 200);

  console.log('[AUDIT:DIAGNOSTIC] 14.3 Testing forged JWT signature rejection...');
  const fakeTokenRes = await fetchWithTimeout(`${BASE_URL}/auth/me`, {
    headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signature' },
  });
  assert.equal(fakeTokenRes.status, 401);
  console.log('[AUDIT:DIAGNOSTIC] Security audit completed successfully.');
});
