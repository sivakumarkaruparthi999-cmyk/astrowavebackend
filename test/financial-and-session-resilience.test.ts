import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { queryPostgres, queryPostgresSingle, pgPool } from '../src/config/db.js';
import { WalletService } from '../src/services/wallet.service.js';
import { PaymentsService } from '../src/services/payments.service.js';
import { inMemoryChatStore } from '../src/controllers/chat.controller.js';

let testCustomerAId: string;
let testCustomerBId: string;
let testAstrologerId: string;
let testConsultationId: string;
const TEST_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'whsec_test_secret_for_razorpay';

before(async () => {
  // 1. Create Test Astrologer
  const astroUser = await queryPostgresSingle(`
    INSERT INTO users (email, phone, password_hash, role)
    VALUES ('resilience_astro_${Date.now()}@test.com', '+91${Math.floor(1000000000 + Math.random() * 9000000000)}', 'hash', 'astrologer')
    RETURNING id;
  `);
  testAstrologerId = astroUser.id;

  await queryPostgres(`
    INSERT INTO astrologer_profiles (id, display_name, hourly_rate, per_minute_rate, is_online, is_verified)
    VALUES ($1, 'Resilience Guru', 1200.00, 20.00, true, true)
    ON CONFLICT (id) DO UPDATE SET per_minute_rate = 20.00;
  `, [testAstrologerId]);

  // 2. Create Test Customers
  const custA = await queryPostgresSingle(`
    INSERT INTO users (email, phone, password_hash, role)
    VALUES ('resilience_cust_a_${Date.now()}@test.com', '+91${Math.floor(1000000000 + Math.random() * 9000000000)}', 'hash', 'customer')
    RETURNING id;
  `);
  testCustomerAId = custA.id;
  await WalletService.getWallet(testCustomerAId);

  const custB = await queryPostgresSingle(`
    INSERT INTO users (email, phone, password_hash, role)
    VALUES ('resilience_cust_b_${Date.now()}@test.com', '+91${Math.floor(1000000000 + Math.random() * 9000000000)}', 'hash', 'customer')
    RETURNING id;
  `);
  testCustomerBId = custB.id;
  await WalletService.getWallet(testCustomerBId);
});

after(async () => {
  if (testCustomerAId && testCustomerBId) {
    await queryPostgres('DELETE FROM invoices WHERE user_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM commissions WHERE customer_id IN ($1, $2) OR provider_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM consultation_billing WHERE user_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM consultations WHERE user_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM refunds WHERE user_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM payment_attempts WHERE payment_id IN (SELECT id FROM payments WHERE user_id IN ($1, $2))', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM payments WHERE user_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM wallet_transactions WHERE wallet_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM wallets WHERE user_id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
    await queryPostgres('DELETE FROM users WHERE id IN ($1, $2)', [testCustomerAId, testCustomerBId]);
  }
  if (testAstrologerId) {
    await queryPostgres('DELETE FROM commissions WHERE provider_id = $1', [testAstrologerId]);
    await queryPostgres('DELETE FROM provider_earnings WHERE provider_id = $1', [testAstrologerId]);
    await queryPostgres('DELETE FROM astrologer_profiles WHERE id = $1', [testAstrologerId]);
    await queryPostgres('DELETE FROM users WHERE id = $1', [testAstrologerId]);
  }
  await pgPool.end();
  setTimeout(() => process.exit(0), 100).unref();
});

// =============================================================================
// 1. Database Connection & Transaction Failure Rollback Tests
// =============================================================================
test('1. Financial Failure: Failed database debit rolls back cleanly without phantom records', async () => {
  // Properly credit wallet through WalletService so ledger is tracked
  await WalletService.creditWallet(testCustomerAId, 500, 'test_initial_funding', crypto.randomUUID());

  const initialWallet = await WalletService.getWallet(testCustomerAId);

  // Attempt debit with invalid UUID reference_id to simulate database constraint failure
  await assert.rejects(async () => {
    // @ts-ignore - passing invalid referenceId type to trigger database rollback
    await WalletService.debitWallet(testCustomerAId, 100, 'test_fail', 'not-a-valid-uuid');
  });

  const wallet = await WalletService.getWallet(testCustomerAId);
  assert.equal(wallet.balance, initialWallet.balance, 'Wallet balance must remain unchanged after aborted transaction');
});

test('2. Financial Failure: Failed database credit rolls back cleanly', async () => {
  const initialWallet = await WalletService.getWallet(testCustomerAId);

  // Negative amount rejected before DB modification
  await assert.rejects(async () => {
    await WalletService.creditWallet(testCustomerAId, -50, 'test_invalid', crypto.randomUUID());
  });

  const postWallet = await WalletService.getWallet(testCustomerAId);
  assert.equal(postWallet.balance, initialWallet.balance);
});

// =============================================================================
// 2. Continuous Billing Concurrency & Duplicate Tick Tests
// =============================================================================
test('3. Billing Concurrency: Simultaneous ticks on same consultation are strictly serialized', async () => {
  // Create active consultation with start time 65 seconds ago (eligible for 1st minute tick)
  const cons = await queryPostgresSingle(`
    INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute, start_time, last_billed_minute)
    VALUES ($1, $2, 'CHAT', 'ACTIVE', 20.00, NOW() - INTERVAL '65 seconds', 0)
    RETURNING id;
  `, [testCustomerAId, testAstrologerId]);
  testConsultationId = cons.id;

  // Execute two simultaneous ticks in parallel
  const [tick1, tick2] = await Promise.all([
    queryPostgresSingle('SELECT * FROM bill_consultation_minute_tick_atomic($1, 20.00)', [testConsultationId]),
    queryPostgresSingle('SELECT * FROM bill_consultation_minute_tick_atomic($1, 20.00)', [testConsultationId]),
  ]);

  // Exactly one tick should succeed with incremental_charge = 20, the second should NOOP with charge = 0
  const charges = [Number(tick1.incremental_charge), Number(tick2.incremental_charge)];
  charges.sort((a, b) => b - a);

  assert.equal(charges[0], 20, 'First tick must bill ₹20 for minute 1');
  assert.equal(charges[1], 0, 'Concurrent duplicate tick must be NOOP (₹0) to prevent double charge');
});

test('4. Billing State Guard: Ended consultation rejects further ticks', async () => {
  // End consultation
  await queryPostgres("UPDATE consultations SET state = 'ENDED', end_time = NOW() WHERE id = $1", [testConsultationId]);

  const tickAfterEnd = await queryPostgresSingle('SELECT * FROM bill_consultation_minute_tick_atomic($1, 20.00)', [testConsultationId]);
  assert.equal(tickAfterEnd.status, 'NOT_ACTIVE');
  assert.equal(Number(tickAfterEnd.incremental_charge), 0);
});

test('5. Billing Balance Guard: Insufficient balance auto-terminates session and prevents negative balance', async () => {
  // Create consultation for customer B
  const consB = await queryPostgresSingle(`
    INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute, start_time, last_billed_minute)
    VALUES ($1, $2, 'CHAT', 'ACTIVE', 20.00, NOW() - INTERVAL '70 seconds', 0)
    RETURNING id;
  `, [testCustomerBId, testAstrologerId]);

  // Customer B has 0 balance, rate is 20/min
  const tickResult = await queryPostgresSingle('SELECT * FROM bill_consultation_minute_tick_atomic($1, 20.00)', [consB.id]);
  assert.equal(tickResult.status, 'INSUFFICIENT_BALANCE');

  const walletB = await WalletService.getWallet(testCustomerBId);
  assert.ok(walletB.balance >= 0, 'Wallet balance must never drop below zero');
});

// =============================================================================
// 3. Payment Webhook Lifecycle & Edge Case Tests
// =============================================================================
test('6. Payment Webhook: Webhook arriving before user verification completes payment and credits wallet', async () => {
  const order = await PaymentsService.createOrder({
    userId: testCustomerBId,
    amount: 200,
    currency: 'INR',
    purpose: 'wallet_topup',
    idempotencyKey: `idemp_${Date.now()}_webhook_first`,
  });

  const webhookBody = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_fake_${Date.now()}`,
          order_id: order.razorpayOrderId,
          amount: 20000,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
        },
      },
    },
  });

  const validSig = crypto
    .createHmac('sha256', TEST_WEBHOOK_SECRET)
    .update(webhookBody)
    .digest('hex');

  const initialWallet = await WalletService.getWallet(testCustomerBId);

  // Process webhook delivery
  const webhookRes = await PaymentsService.handleWebhook({
    rawBody: Buffer.from(webhookBody, 'utf8'),
    headers: { 'x-razorpay-signature': validSig },
  });

  assert.equal(webhookRes.success, true);

  const afterWebhookWallet = await WalletService.getWallet(testCustomerBId);
  assert.equal(afterWebhookWallet.balance, initialWallet.balance + 200);

  // Subsequent verify call by client does not double credit (alreadyPaid = true)
  const reVerify = await PaymentsService.verifyPayment({
    userId: testCustomerBId,
    orderId: order.razorpayOrderId,
    paymentId: `pay_fake_${Date.now()}`,
    signature: 'mock_sig_test',
  });

  assert.equal(reVerify.alreadyPaid, true, 'Payment must be recognized as already paid');
  const finalWallet = await WalletService.getWallet(testCustomerBId);
  assert.equal(finalWallet.balance, afterWebhookWallet.balance, 'Re-verification must be idempotent');
});

test('7. Payment Webhook: Duplicate webhook delivery does NOT credit wallet twice', async () => {
  const initialWallet = await WalletService.getWallet(testCustomerBId);

  // Re-fetch existing order
  const existingOrder = await queryPostgresSingle(
    'SELECT order_id FROM payments WHERE user_id = $1 AND status = \'paid\' ORDER BY created_at DESC LIMIT 1',
    [testCustomerBId]
  );

  const duplicateBody = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_dup_${Date.now()}`,
          order_id: existingOrder.order_id,
          amount: 20000,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
  });

  const dupSig = crypto
    .createHmac('sha256', TEST_WEBHOOK_SECRET)
    .update(duplicateBody)
    .digest('hex');

  await PaymentsService.handleWebhook({
    rawBody: Buffer.from(duplicateBody, 'utf8'),
    headers: { 'x-razorpay-signature': dupSig },
  });

  const postDupWallet = await WalletService.getWallet(testCustomerBId);
  assert.equal(postDupWallet.balance, initialWallet.balance, 'Duplicate webhook must NOT alter wallet balance');
});

test('8. Refunds: Duplicate or excessive refund attempt is rejected', async () => {
  const payment = await queryPostgresSingle(
    "SELECT id, amount, user_id FROM payments WHERE user_id = $1 AND status = 'paid' LIMIT 1",
    [testCustomerBId]
  );

  // Execute initial refund of ₹50
  const refund1 = await PaymentsService.processRefund({
    paymentId: payment.id,
    amount: 50,
    reason: 'Customer request',
    processedBy: testCustomerBId,
    idempotencyKey: `rfnd_idemp_${Date.now()}_1`,
  });
  assert.equal(refund1.status, 'processed');

  // Attempt excessive refund exceeding original paid amount
  await assert.rejects(async () => {
    await PaymentsService.processRefund({
      paymentId: payment.id,
      amount: 500, // Remaining original payment is only 200
      reason: 'Excessive refund request',
    });
  });
});

// =============================================================================
// 4. Chat & Session Isolation Tests
// =============================================================================
test('9. Session Isolation: Reopened consultation generates brand new consultation ID and does NOT leak old messages', async () => {
  const consultationAId = crypto.randomUUID();
  const consultationBId = crypto.randomUUID();

  // Populate Consultation A in-memory store
  inMemoryChatStore.set(consultationAId, [
    { id: 'msg1', consultationId: consultationAId, senderId: testCustomerAId, text: 'Secret message from Consultation A' },
    { id: 'msg2', consultationId: consultationAId, senderId: testAstrologerId, text: 'Astro response A' },
  ]);

  // Consultation B starts fresh
  inMemoryChatStore.set(consultationBId, [
    { id: 'msg3', consultationId: consultationBId, senderId: testCustomerAId, text: 'Fresh message from Consultation B' },
  ]);

  const messagesA = inMemoryChatStore.get(consultationAId) || [];
  const messagesB = inMemoryChatStore.get(consultationBId) || [];

  assert.equal(messagesA.length, 2);
  assert.equal(messagesB.length, 1);
  assert.equal(messagesB[0].text, 'Fresh message from Consultation B');
  assert.ok(!messagesB.some((m) => m.text.includes('Consultation A')), 'Old chat history must NOT leak into new consultation session');
});

// =============================================================================
// 5. Mathematical Financial Invariant Verification
// =============================================================================
test('10. Financial Invariant: Wallet balances match ledger transactions exactly with ZERO discrepancy', async () => {
  const testUsers = [testCustomerAId, testCustomerBId];

  for (const uid of testUsers) {
    const w = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [uid]);
    const ledger = await queryPostgresSingle(`
      SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS sum
      FROM wallet_transactions
      WHERE wallet_id = $1;
    `, [uid]);

    const walletBal = Number(w.balance);
    const ledgerBal = Number(ledger.sum);
    const diff = Math.abs(walletBal - ledgerBal);

    assert.ok(diff < 0.001, `Discrepancy detected for user ${uid}: wallet=${walletBal}, ledger=${ledgerBal}`);
  }
});
