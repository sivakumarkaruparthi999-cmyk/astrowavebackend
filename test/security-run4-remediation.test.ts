import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';
import { CallsController } from '../src/controllers/calls.controller.js';
import { ConsultationsController } from '../src/controllers/consultations.controller.js';
import { hashPassword } from '../src/auth/jwt.js';

describe('Security Audit Run 4 Remediations', () => {
  it('should reject video session logging from unauthorized third party with HTTP 403', async () => {
    const passHash = await hashPassword('Pass@123');

    // 1. Create Customer A and Astrologer B
    const userA = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'customer', 'active', true)
       RETURNING id`,
      [`run4_usera_${Date.now()}@test.com`, passHash]
    );

    const astroB = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'astrologer', 'active', true)
       RETURNING id`,
      [`run4_astrob_${Date.now()}@test.com`, passHash]
    );

    // 2. Create Consultation between User A and Astro B
    const consultation = await queryPostgresSingle(
      `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute)
       VALUES ($1, $2, 'video', 'ACTIVE', 30.00)
       RETURNING id`,
      [userA.id, astroB.id]
    );

    // 3. Create unrelated Attacker User C
    const userC = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'customer', 'active', true)
       RETURNING id`,
      [`run4_userc_attacker_${Date.now()}@test.com`, passHash]
    );

    // 4. User C attempts to log/overwrite video session for consultation between A and B
    const mockReq: any = {
      user: { userId: userC.id, role: 'customer' },
      body: {
        consultationId: consultation.id,
        sessionId: `vses_spoof_${Date.now()}`,
        webrtcRoomId: 'room_spoof_456',
        status: 'connected',
      },
    };

    let statusCode = 200;
    let responseBody: any = null;
    const mockRes: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: any) {
        responseBody = data;
        return this;
      },
    };

    await CallsController.logVideoSession(mockReq, mockRes);

    // Assert: Unauthorized third party is rejected with 403 Forbidden
    assert.strictEqual(statusCode, 403);
    assert.strictEqual(responseBody?.success, false);
    assert.match(responseBody?.error, /Forbidden: You are not authorized to log video sessions for this consultation/);

    // 5. Authorized Customer A succeeds (or gets 200)
    const authReq: any = {
      user: { userId: userA.id, role: 'customer' },
      body: {
        consultationId: consultation.id,
        sessionId: `vses_auth_${Date.now()}`,
        webrtcRoomId: 'room_auth_123',
        status: 'connected',
      },
    };
    let authCode = 200;
    let authBody: any = null;
    const authRes: any = {
      status(code: number) {
        authCode = code;
        return this;
      },
      json(data: any) {
        authBody = data;
        return this;
      },
    };
    await CallsController.logVideoSession(authReq, authRes);
    assert.strictEqual(authCode, 200);
    assert.strictEqual(authBody?.success, true);
  });

  it('should reject self-consultation creation with HTTP 400', async () => {
    const passHash = await hashPassword('Pass@123');

    // 1. Create dual-role Astrologer
    const astro = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'astrologer', 'active', true)
       RETURNING id`,
      [`run4_dual_${Date.now()}@test.com`, passHash]
    );

    await queryPostgres(
      `INSERT INTO astrologer_profiles (id, display_name, per_minute_rate, is_verified)
       VALUES ($1, 'Self Doctor', 25.00, true)
       ON CONFLICT (id) DO NOTHING`,
      [astro.id]
    );

    await queryPostgres(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 500.00)
       ON CONFLICT (user_id) DO UPDATE SET balance = 500.00`,
      [astro.id]
    );

    // 2. Astrologer attempts to book consultation with themselves
    const mockReq: any = {
      user: { userId: astro.id, role: 'astrologer' },
      body: {
        astrologerId: astro.id,
        type: 'chat',
      },
    };

    let statusCode = 200;
    let responseBody: any = null;
    const mockRes: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: any) {
        responseBody = data;
        return this;
      },
    };

    await ConsultationsController.create(mockReq, mockRes);

    // Assert: Rejected with 400 Bad Request
    assert.strictEqual(statusCode, 400);
    assert.strictEqual(responseBody?.success, false);
    assert.match(responseBody?.error, /Cannot initiate consultation with yourself/);

    // Clean up temporary test astrologer and wallet
    await queryPostgres('DELETE FROM users WHERE id = $1', [astro.id]);
  });
});
