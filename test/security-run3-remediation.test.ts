import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';
import { PayoutsController } from '../src/controllers/payouts.controller.js';
import { hashPassword } from '../src/auth/jwt.js';

describe('Security Audit Run 3 Remediations', () => {
  it('should reject invalid birthDate format with HTTP 400 on authenticated kundli save', async () => {
    // 1. Create a customer
    const passHash = await hashPassword('TestSec3@123');
    const user = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'customer', 'active', true)
       RETURNING id`,
      [`sec3_cust_${Date.now()}@example.com`, passHash]
    );

    // Test API call
    const loginRes = await fetch('http://localhost:5001/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `sec3_cust_${Date.now() - 50}@example.com`, password: 'TestSec3@123' }),
    });

    const res = await fetch('http://localhost:5001/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `sec3_reg_${Date.now()}@test.com`, password: 'TestSec3@123', fullName: 'Tester' }),
    });
    const regData: any = await res.json();
    const token = regData?.data?.accessToken;

    const testRes = await fetch('http://localhost:5001/api/users/kundli', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'Test',
        birthDate: 'invalid-date',
        birthTime: '12:00',
        birthPlace: 'Delhi',
        latitude: 28.6,
        longitude: 77.2,
      }),
    });
    const json: any = await testRes.json();
    assert.strictEqual(testRes.status, 400);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Invalid birthDate format/);
  });

  it('should reject foreign payoutAccountId with HTTP 403 in PayoutsController.requestPayout', async () => {
    const passHash = await hashPassword('ProviderPass@123');

    // 1. Create Provider A
    const providerA = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'astrologer', 'active', true)
       RETURNING id`,
      [`provider_a_${Date.now()}@test.com`, passHash]
    );
    await queryPostgres(
      `INSERT INTO provider_earnings (provider_id, total_earned, available_balance, withdrawn_amount, pending_payout_amount)
       VALUES ($1, 2000.00, 2000.00, 0.00, 0.00)
       ON CONFLICT (provider_id) DO UPDATE SET available_balance = 2000.00`,
      [providerA.id]
    );

    // 2. Create Provider B with their own payout account
    const providerB = await queryPostgresSingle(
      `INSERT INTO users (email, password_hash, role, status, is_verified)
       VALUES ($1, $2, 'astrologer', 'active', true)
       RETURNING id`,
      [`provider_b_${Date.now()}@test.com`, passHash]
    );
    const accountB = await queryPostgresSingle(
      `INSERT INTO payout_accounts (provider_id, account_type, account_holder_name, account_number, ifsc_code, is_verified)
       VALUES ($1, 'bank_account', 'Provider B', '987654321098', 'HDFC0001234', true)
       RETURNING id`,
      [providerB.id]
    );

    // 3. Provider A attempts to request payout using Provider B's payout account ID
    const mockReq: any = {
      user: { userId: providerA.id, role: 'astrologer' },
      body: {
        amount: 500,
        payoutAccountId: accountB.id, // Foreign account belonging to Provider B
      },
    };

    let responseCode = 200;
    let responseBody: any = null;
    const mockRes: any = {
      status(code: number) {
        responseCode = code;
        return this;
      },
      json(data: any) {
        responseBody = data;
        return this;
      },
    };

    await PayoutsController.requestPayout(mockReq, mockRes);

    // Assert: Foreign account ID is rejected with 403 Forbidden
    assert.strictEqual(responseCode, 403);
    assert.strictEqual(responseBody?.success, false);
    assert.match(responseBody?.error, /Unauthorized: Payout account does not exist or does not belong to your profile/);

    // Verify no withdrawal occurred from Provider A's earnings
    const earningsA = await queryPostgresSingle(
      'SELECT available_balance, pending_payout_amount FROM provider_earnings WHERE provider_id = $1',
      [providerA.id]
    );
    assert.strictEqual(Number(earningsA.available_balance), 2000.00);
    assert.strictEqual(Number(earningsA.pending_payout_amount), 0.00);
  });
});
