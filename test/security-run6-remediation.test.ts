import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AstrologersController } from '../src/controllers/astrologers.controller.js';
import { WalletController } from '../src/controllers/wallet.controller.js';
import { queryPostgresSingle } from '../src/config/db.js';
import { hashPassword } from '../src/auth/jwt.js';

describe('Security Audit Run 6 Remediations', () => {
  it('should reject negative or non-numeric perMinuteRate in Astrologer status update with HTTP 400', async () => {
    const passHash = await hashPassword('Pass@123');
    const astrologer = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'astrologer', 'active', true)
       RETURNING id`,
      [`run6_astro_${Date.now()}@test.com`, passHash]
    );

    await queryPostgresSingle(
      `INSERT INTO astrologer_profiles (id, display_name, per_minute_rate, hourly_rate, is_verified)
       VALUES ($1, 'Test Astro Run6', 25.0, 1500.0, true)
       RETURNING id`,
      [astrologer.id]
    );

    // 1. Negative rate
    const mockReqNegative: any = {
      user: { userId: astrologer.id, role: 'astrologer' },
      body: { perMinuteRate: -50 },
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

    await AstrologersController.updateStatus(mockReqNegative, mockRes);
    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /perMinuteRate must be a number between/i);

    // 2. String/NaN rate
    const mockReqNaN: any = {
      user: { userId: astrologer.id, role: 'astrologer' },
      body: { perMinuteRate: 'invalid_string' },
    };
    await AstrologersController.updateStatus(mockReqNaN, mockRes);
    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /perMinuteRate must be a number between/i);
  });

  it('should reject invalid array types for languages or specializations with HTTP 400', async () => {
    const mockReq: any = {
      user: { userId: '10000000-0000-0000-0000-000000000001', role: 'astrologer' },
      body: { languages: 'Hindi, English' }, // string instead of array
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

    await AstrologersController.updateStatus(mockReq, mockRes);
    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /languages must be an array/i);
  });

  it('should reject negative or zero recharge amount in WalletController with HTTP 400', async () => {
    const mockReq: any = {
      user: { userId: '10000000-0000-0000-0000-000000000001', role: 'customer' },
      body: { amount: -100 },
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

    await WalletController.recharge(mockReq, mockRes);
    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /Recharge amount must be a number between/i);
  });

  it('should reject non-numeric recharge amount in WalletController with HTTP 400', async () => {
    const mockReq: any = {
      user: { userId: '10000000-0000-0000-0000-000000000001', role: 'customer' },
      body: { amount: 'ten_thousand' },
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

    await WalletController.recharge(mockReq, mockRes);
    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /Recharge amount must be a number between/i);
  });
});
