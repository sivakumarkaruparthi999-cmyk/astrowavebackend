import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MuhuratController } from '../src/controllers/muhurat.controller.js';
import { PoojaController } from '../src/controllers/pooja.controller.js';
import { queryPostgresSingle } from '../src/config/db.js';
import { hashPassword } from '../src/auth/jwt.js';

describe('Security Audit Run 5 Remediations', () => {
  it('should reject malformed date in Muhurat calculation with HTTP 400', async () => {
    const mockReq: any = {
      body: {
        date: 'invalid-date-format',
        latitude: 28.6139,
        longitude: 77.2090,
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

    await MuhuratController.calculate(mockReq, mockRes);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /Invalid date format/i);
  });

  it('should reject out-of-bounds coordinates in Muhurat calculation with HTTP 400', async () => {
    const mockReq: any = {
      body: {
        date: '2026-09-19',
        latitude: 999.99,
        longitude: 77.2090,
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

    await MuhuratController.calculate(mockReq, mockRes);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /Invalid coordinates/i);
  });

  it('should return valid muhurat calculation for valid inputs with HTTP 200', async () => {
    const mockReq: any = {
      body: {
        date: '2026-09-19',
        latitude: 28.6139,
        longitude: 77.2090,
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

    await MuhuratController.calculate(mockReq, mockRes);

    assert.equal(statusCode, 200);
    assert.equal(responseBody.success, true);
    assert.ok(responseBody.data);
    assert.ok(responseBody.data.auspiciousWindows);
    assert.ok(responseBody.data.tithi);
  });

  it('should reject malformed bookingDate in Pooja booking with HTTP 400', async () => {
    const passHash = await hashPassword('Pass@123');
    const testUser = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'customer', 'active', true)
       RETURNING id`,
      [`run5_user_${Date.now()}@test.com`, passHash]
    );

    const mockReq: any = {
      user: { userId: testUser.id, role: 'customer' },
      body: {
        poojaServiceId: 'invalid-uuid-or-id',
        bookingDate: 'not-a-valid-date',
        bookingTime: '10:00',
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

    await PoojaController.bookPooja(mockReq, mockRes);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /Invalid bookingDate format/i);
  });

  it('should reject malformed bookingTime in Pooja booking with HTTP 400', async () => {
    const passHash = await hashPassword('Pass@123');
    const testUser = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'customer', 'active', true)
       RETURNING id`,
      [`run5_user_time_${Date.now()}@test.com`, passHash]
    );

    const mockReq: any = {
      user: { userId: testUser.id, role: 'customer' },
      body: {
        poojaServiceId: 'service-123',
        bookingDate: '2026-09-20',
        bookingTime: '28:99', // invalid hour and minute
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

    await PoojaController.bookPooja(mockReq, mockRes);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.match(responseBody.error, /Invalid bookingTime format/i);
  });
});
