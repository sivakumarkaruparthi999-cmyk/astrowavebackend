import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;
import { pgPool } from '../src/config/db.js';

// =============================================================================
// Helper: Dual-Key JWT Verification (Zero-Downtime Rotation Pattern)
// =============================================================================
function verifyJwtWithRotation(token: string, secrets: string[]): any {
  for (let i = 0; i < secrets.length; i++) {
    try {
      return jwt.verify(token, secrets[i]);
    } catch (err: any) {
      // If token expired, reject immediately
      if (err.name === 'TokenExpiredError') {
        throw err;
      }
      // If invalid signature and another fallback secret exists, continue
      if (i < secrets.length - 1) {
        continue;
      }
      throw err;
    }
  }
}

// Helper: Dual-Secret HMAC Verification for Webhooks/Payments
function verifyHmacWithRotation(payload: string, signature: string, secrets: string[]): boolean {
  for (const secret of secrets) {
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// 1. JWT Signing Key Zero-Downtime Rotation Dry Run
// =============================================================================
test('1. Secret Rotation: JWT Access Token dual-secret verification during rotation', () => {
  const JWT_SECRET_OLD = 'old_secret_key_that_is_at_least_32_characters_long';
  const JWT_SECRET_NEW = 'new_secret_key_that_is_at_least_32_characters_long';

  // 1. Active user has token issued under OLD key
  const activeUserToken = jwt.sign(
    { userId: 'user-123', role: 'customer' },
    JWT_SECRET_OLD,
    { expiresIn: '1h' }
  );

  // 2. Secret is rotated; rotation array has NEW key first, OLD key as fallback
  const activeSecrets = [JWT_SECRET_NEW, JWT_SECRET_OLD];

  // 3. User with old token authenticates seamlessly (Zero Downtime)
  const decodedOld = verifyJwtWithRotation(activeUserToken, activeSecrets);
  assert.equal(decodedOld.userId, 'user-123');

  // 4. New tokens are signed exclusively with NEW key
  const newUserToken = jwt.sign(
    { userId: 'user-456', role: 'astrologer' },
    JWT_SECRET_NEW,
    { expiresIn: '1h' }
  );
  const decodedNew = verifyJwtWithRotation(newUserToken, activeSecrets);
  assert.equal(decodedNew.userId, 'user-456');

  // 5. Tampered token is strictly rejected under both keys
  assert.throws(() => {
    verifyJwtWithRotation(activeUserToken + 'tampered', activeSecrets);
  });
});

// =============================================================================
// 2. Refresh Token Rotation Dry Run
// =============================================================================
test('2. Secret Rotation: Refresh token rotation issues new credentials seamlessly', () => {
  const REFRESH_OLD = 'old_refresh_secret_at_least_32_characters_long';
  const REFRESH_NEW = 'new_refresh_secret_at_least_32_characters_long';

  const userRefreshToken = jwt.sign(
    { userId: 'user-123', tokenVersion: 1 },
    REFRESH_OLD,
    { expiresIn: '30d' }
  );

  const activeRefreshSecrets = [REFRESH_NEW, REFRESH_OLD];

  // Verify old refresh token under dual secrets
  const decoded = verifyJwtWithRotation(userRefreshToken, activeRefreshSecrets);
  assert.equal(decoded.userId, 'user-123');

  // Issue newly rotated refresh token
  const nextRefreshToken = jwt.sign(
    { userId: decoded.userId, tokenVersion: decoded.tokenVersion + 1 },
    REFRESH_NEW,
    { expiresIn: '30d' }
  );

  const decodedNext = verifyJwtWithRotation(nextRefreshToken, activeRefreshSecrets);
  assert.equal(decodedNext.userId, 'user-123');
  assert.equal(decodedNext.tokenVersion, 2);
});

// =============================================================================
// 3. PostgreSQL Database Credential Rotation Dry Run
// =============================================================================
test('3. Secret Rotation: PostgreSQL secondary user creation and credential swapping', async () => {
  const pgHost = process.env.PGHOST || 'localhost';
  const pgPort = parseInt(process.env.PGPORT || '5432', 10);
  const pgUser = process.env.PGUSER || 'postgres';
  const pgPassword = process.env.PGPASSWORD || 'javed@2004';
  const database = process.env.PGDATABASE || 'astrotalk';

  const tempUser = `astrowave_rot_${Date.now()}`;
  const tempPass = `RotPass_${crypto.randomBytes(8).toString('hex')}!`;

  const adminClient = await pgPool.connect();
  try {
    // 1. Create secondary database role
    await adminClient.query(`CREATE USER ${tempUser} WITH PASSWORD '${tempPass}';`);
    await adminClient.query(`GRANT CONNECT ON DATABASE ${database} TO ${tempUser};`);
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO ${tempUser};`);
    await adminClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${tempUser};`);

    // 2. Connect with newly rotated credentials
    const rotatedPool = new Pool({
      host: pgHost,
      port: pgPort,
      user: tempUser,
      password: tempPass,
      database,
    });

    const res = await rotatedPool.query('SELECT 1 AS connected, current_user;');
    assert.equal(res.rows[0].connected, 1);
    assert.equal(res.rows[0].current_user, tempUser);
    await rotatedPool.end();

    // 3. Cleanup temporary rotated role
    await adminClient.query(`DROP OWNED BY ${tempUser};`);
    await adminClient.query(`DROP USER ${tempUser};`);
  } finally {
    adminClient.release();
  }
});

// =============================================================================
// 4. Razorpay Webhook & Payment Secret Rotation Dry Run
// =============================================================================
test('4. Secret Rotation: Razorpay dual-secret HMAC transition pattern', () => {
  const WEBHOOK_SECRET_OLD = 'whsec_old_secret_hash_key_12345';
  const WEBHOOK_SECRET_NEW = 'whsec_new_secret_hash_key_67890';

  const testPayload = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_test123', amount: 50000 } } },
  });

  // Webhook signed with old secret during transition grace period
  const oldSignature = crypto.createHmac('sha256', WEBHOOK_SECRET_OLD).update(testPayload).digest('hex');

  const activeWebhookSecrets = [WEBHOOK_SECRET_NEW, WEBHOOK_SECRET_OLD];

  // Must accept webhook signed with old secret
  const isValidOld = verifyHmacWithRotation(testPayload, oldSignature, activeWebhookSecrets);
  assert.equal(isValidOld, true);

  // Must accept webhook signed with new secret
  const newSignature = crypto.createHmac('sha256', WEBHOOK_SECRET_NEW).update(testPayload).digest('hex');
  const isValidNew = verifyHmacWithRotation(testPayload, newSignature, activeWebhookSecrets);
  assert.equal(isValidNew, true);

  // Forged signature must be rejected
  const isForgedValid = verifyHmacWithRotation(testPayload, 'forged_signature_0000000000000000000000000000000000000000000000000000000000000000', activeWebhookSecrets);
  assert.equal(isForgedValid, false);
});

test('5. Secret Rotation: Clean exit', async () => {
  await pgPool.end();
  setTimeout(() => process.exit(0), 100).unref();
});

