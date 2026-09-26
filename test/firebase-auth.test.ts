import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import app from '../src/app.js';
import { queryPostgres, queryPostgresSingle, connectMongo, pgPool } from '../src/config/db.js';
import { verifyFirebaseIdToken } from '../src/services/firebase.service.js';
import { syncFirebaseUser } from '../src/services/user-sync.service.js';
import { signAccessToken, hashPassword } from '../src/auth/jwt.js';

let server: http.Server;
let baseUrl = '';
let testAdminId = '';
let testAdminToken = '';

before(async () => {
  await connectMongo();

  // Start ephemeral HTTP server on random free port
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  // Create an admin user to test admin vs customer isolation
  const adminPass = await hashPassword('AdminPass@123');
  const adminEmail = `fb_test_admin_${Date.now()}@astrowave.com`;
  const admin = await queryPostgresSingle(
    `INSERT INTO users (email, password_hash, role, status, is_verified)
     VALUES ($1, $2, 'admin', 'active', true)
     RETURNING id, email, role`,
    [adminEmail, adminPass]
  );
  testAdminId = admin.id;
  testAdminToken = signAccessToken({ userId: admin.id, email: admin.email, role: 'admin' });
});

after(async () => {
  if (testAdminId) {
    await queryPostgres('DELETE FROM refresh_tokens WHERE user_id = $1', [testAdminId]).catch(() => {});
    await queryPostgres('DELETE FROM users WHERE id = $1', [testAdminId]).catch(() => {});
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try { await pgPool.end(); } catch {}
  try {
    const { closeRedis } = await import('../src/config/redis.js');
    await closeRedis();
  } catch {}
  setTimeout(() => process.exit(0), 100).unref();
});

test('Firebase Service: verifies test tokens deterministically in test mode', async () => {
  const decoded = await verifyFirebaseIdToken('test_firebase_phone_+919876543210', true);
  assert.ok(decoded.uid.includes('9876543210'));
  assert.strictEqual(decoded.phone_number, '+919876543210');
  assert.strictEqual(decoded.sign_in_provider, 'phone');

  const decodedGoogle = await verifyFirebaseIdToken('test_firebase_google_john.doe@gmail.com', true);
  assert.strictEqual(decodedGoogle.email, 'john.doe@gmail.com');
  assert.strictEqual(decodedGoogle.sign_in_provider, 'google.com');
});

test('UserSync Service: registers new customer with profile and initial zero-balance wallet', async () => {
  const testPhone = `+9198${Math.floor(10000000 + Math.random() * 90000000)}`;
  const decoded = await verifyFirebaseIdToken(`test_firebase_phone_${testPhone}`, true);

  const synced = await syncFirebaseUser(decoded);
  assert.ok(synced.id, 'User ID should be a valid UUID');
  assert.strictEqual(synced.role, 'customer');
  assert.strictEqual(synced.phone, testPhone);
  assert.strictEqual(synced.is_verified, true);
  assert.ok(synced.firebase_uid, 'Firebase UID must be persisted');

  // Verify wallet was created with 0.00 balance
  const wallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [synced.id]);
  assert.ok(wallet, 'Wallet row should exist');
  assert.strictEqual(parseFloat(wallet.balance), 0);

  // Clean up
  await queryPostgres('DELETE FROM wallets WHERE user_id = $1', [synced.id]);
  await queryPostgres('DELETE FROM profiles WHERE id = $1', [synced.id]);
  await queryPostgres('DELETE FROM users WHERE id = $1', [synced.id]);
});

test('POST /api/auth/firebase: exchanges Firebase ID token for AstroWave session tokens', async () => {
  const testPhone = `+9195${Math.floor(10000000 + Math.random() * 90000000)}`;
  const idToken = `test_firebase_phone_${testPhone}`;

  const res = await fetch(`${baseUrl}/api/auth/firebase`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-mode': 'true',
    },
    body: JSON.stringify({ idToken }),
  });

  const json: any = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(json.success, true);
  assert.ok(json.data.accessToken, 'Access token must be returned');
  assert.ok(json.data.refreshToken, 'Refresh token must be returned');
  assert.strictEqual(json.data.user.role, 'customer');
  assert.strictEqual(json.data.user.phone, testPhone);
  assert.strictEqual(json.data.user.isNewUser, true, 'First signup must set isNewUser to true');

  const createdUserId = json.data.user.id;

  // Repeat call with same token to verify idempotent session restoration
  const res2 = await fetch(`${baseUrl}/api/auth/firebase`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-mode': 'true',
    },
    body: JSON.stringify({ idToken }),
  });

  const json2: any = await res2.json();
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(json2.data.user.id, createdUserId, 'Existing user ID must be retained');
  assert.strictEqual(json2.data.user.isNewUser, false, 'Existing user signin must set isNewUser to false');

  // Clean up
  await queryPostgres('DELETE FROM refresh_tokens WHERE user_id = $1', [createdUserId]);
  await queryPostgres('DELETE FROM wallets WHERE user_id = $1', [createdUserId]);
  await queryPostgres('DELETE FROM profiles WHERE id = $1', [createdUserId]);
  await queryPostgres('DELETE FROM users WHERE id = $1', [createdUserId]);
});

test('Dual-Mode Middleware: protected route accepts direct Firebase ID Token', async () => {
  const testPhone = `+9194${Math.floor(10000000 + Math.random() * 90000000)}`;
  const idToken = `test_firebase_phone_${testPhone}`;

  // Call /api/auth/me directly with Bearer Firebase ID Token
  const res = await fetch(`${baseUrl}/api/auth/me`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'x-test-mode': 'true',
    },
  });

  const json: any = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.data.phone, testPhone);
  assert.strictEqual(json.data.role, 'customer');

  const userId = json.data.id;

  // Clean up
  await queryPostgres('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  await queryPostgres('DELETE FROM wallets WHERE user_id = $1', [userId]);
  await queryPostgres('DELETE FROM profiles WHERE id = $1', [userId]);
  await queryPostgres('DELETE FROM users WHERE id = $1', [userId]);
});

test('Security & Role Boundaries: Firebase customer cannot access Admin APIs', async () => {
  const testPhone = `+9193${Math.floor(10000000 + Math.random() * 90000000)}`;
  const customerToken = `test_firebase_phone_${testPhone}`;

  // Customer attempts to access Admin endpoint
  const adminRes = await fetch(`${baseUrl}/api/admin/astrologers/pending`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${customerToken}`,
      'x-test-mode': 'true',
    },
  });

  assert.strictEqual(adminRes.status, 403, 'Customer must be blocked from admin route with 403 Forbidden');

  // Valid admin token should succeed (or not 403)
  const legitAdminRes = await fetch(`${baseUrl}/api/admin/astrologers/pending`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${testAdminToken}`,
    },
  });

  assert.notStrictEqual(legitAdminRes.status, 403, 'Admin token must not be forbidden on admin route');
});

test('Authentication: rejects invalid or missing tokens with 401', async () => {
  const resMissing = await fetch(`${baseUrl}/api/auth/me`);
  assert.strictEqual(resMissing.status, 401);

  const resInvalid = await fetch(`${baseUrl}/api/auth/me`, {
    headers: {
      'Authorization': 'Bearer invalid_garbage_token_12345',
    },
  });
  assert.strictEqual(resInvalid.status, 401);
});
