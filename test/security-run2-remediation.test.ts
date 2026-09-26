import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';
import { AdminController } from '../src/controllers/admin.controller.js';
import { hashPassword, hashToken } from '../src/auth/jwt.js';

describe('Security Audit Run 2 Remediations', () => {
  it('should reject invalid birth date format with HTTP 400 on kundli API', async () => {
    const res = await fetch('http://localhost:5001/api/astrology/kundli/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        birth_date: 'invalid-date',
        birth_time: '12:00',
        birth_place: 'Delhi',
        latitude: 28.6,
        longitude: 77.2,
      }),
    });
    const json: any = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Invalid birth_date format/);
  });

  it('should reject invalid time format with HTTP 400 on kundli API', async () => {
    const res = await fetch('http://localhost:5001/api/astrology/kundli/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        birth_date: '1995-10-25',
        birth_time: '25:99',
        birth_place: 'Delhi',
        latitude: 28.6,
        longitude: 77.2,
      }),
    });
    const json: any = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Invalid birth_time format/);
  });

  it('should reject out-of-bounds latitude with HTTP 400 on kundli API', async () => {
    const res = await fetch('http://localhost:5001/api/astrology/kundli/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        birth_date: '1995-10-25',
        birth_time: '12:00',
        birth_place: 'Delhi',
        latitude: 105.0,
        longitude: 77.2,
      }),
    });
    const json: any = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Invalid latitude/);
  });

  it('should reject out-of-bounds longitude with HTTP 400 on kundli API', async () => {
    const res = await fetch('http://localhost:5001/api/astrology/kundli/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        birth_date: '1995-10-25',
        birth_time: '12:00',
        birth_place: 'Delhi',
        latitude: 28.6,
        longitude: -250.0,
      }),
    });
    const json: any = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Invalid longitude/);
  });

  it('should accept properly formatted parameters and return calculated chart', async () => {
    const res = await fetch('http://localhost:5001/api/astrology/kundli/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Aarav',
        gender: 'male',
        birth_date: '1995-10-25',
        birth_time: '14:30',
        birth_place: 'New Delhi',
        latitude: 28.6139,
        longitude: 77.2090,
      }),
    });
    const json: any = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.ok(json.data.lagna);
    assert.ok(json.data.planets);
  });

  it('should cascade session revocation and invalidate refresh tokens upon admin account block', async () => {
    // 1. Create a test user
    const passHash = await hashPassword('TestSec@123');
    const user = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'customer', 'active', true)
       RETURNING id`,
      [`sec_test_${Date.now()}@example.com`, passHash]
    );

    // 2. Insert active refresh tokens
    const dummyTokenHash = hashToken(`mock_refresh_token_${Date.now()}`);
    await queryPostgres(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked)
       VALUES ($1, $2, NOW() + INTERVAL '30 days', false)`,
      [user.id, dummyTokenHash]
    );

    // Verify token is active
    const beforeTokens = await queryPostgres(
      'SELECT id, revoked FROM refresh_tokens WHERE user_id = $1 AND revoked = false',
      [user.id]
    );
    assert.strictEqual(beforeTokens.length, 1);

    // 3. Create Admin user for audit log FK and simulate Admin status update to 'blocked'
    const adminUser = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'super_admin', 'active', true)
       RETURNING id`,
      [`admin_test_${Date.now()}@example.com`, passHash]
    );

    const mockReq: any = {
      user: { userId: adminUser.id, role: 'super_admin' },
      params: { id: user.id },
      body: { status: 'blocked' },
    };
    let responseData: any = null;
    let statusCode = 200;
    const mockRes: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: any) {
        responseData = data;
        return this;
      },
    };

    await AdminController.updateUserStatus(mockReq, mockRes);
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(responseData?.success, true);
    assert.strictEqual(responseData?.data?.status, 'blocked');

    // 4. Verify all refresh tokens for this user are now revoked
    const afterActiveTokens = await queryPostgres(
      'SELECT id FROM refresh_tokens WHERE user_id = $1 AND revoked = false',
      [user.id]
    );
    assert.strictEqual(afterActiveTokens.length, 0, 'All active refresh tokens must be marked revoked');

    const revokedTokens = await queryPostgres(
      'SELECT id, revoked, revoked_at FROM refresh_tokens WHERE user_id = $1 AND revoked = true',
      [user.id]
    );
    assert.strictEqual(revokedTokens.length, 1);
    assert.ok(revokedTokens[0].revoked_at !== null, 'revoked_at timestamp must be set');
  });
});
