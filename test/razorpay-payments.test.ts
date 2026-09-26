import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { queryPostgres, queryPostgresSingle, pgPool } from '../src/config/db.js';
import { PaymentsService } from '../src/services/payments.service.js';
import { WalletService } from '../src/services/wallet.service.js';
import { getRazorpayKeyId, verifyPaymentSignature, verifyWebhookSignature } from '../src/config/razorpay.js';

let testUser1Id = '';
let testUser2Id = '';
const TEST_RAZORPAY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_secret_for_razorpay';
const TEST_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'whsec_test_secret_for_razorpay';

before(async () => {
  console.log('[RAZORPAY TEST:SETUP] Initializing test users in PostgreSQL...');
  
  const phone1 = `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  const phone2 = `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`;

  const user1 = await queryPostgresSingle(`
    INSERT INTO users (email, phone, password_hash, role)
    VALUES ('razorpay_user1_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@test.com', $1, 'test_password_hash', 'customer')
    RETURNING id;
  `, [phone1]);
  testUser1Id = user1.id;

  const user2 = await queryPostgresSingle(`
    INSERT INTO users (email, phone, password_hash, role)
    VALUES ('razorpay_user2_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@test.com', $1, 'test_password_hash', 'customer')
    RETURNING id;
  `, [phone2]);
  testUser2Id = user2.id;

  // Initialize wallets
  await WalletService.getWallet(testUser1Id);
  await WalletService.getWallet(testUser2Id);
});

after(async () => {
  console.log('[RAZORPAY TEST:CLEANUP] Cleaning up test data...');
  if (testUser1Id && testUser2Id) {
    await queryPostgres('DELETE FROM audit_logs WHERE user_id IN ($1, $2)', [testUser1Id, testUser2Id]);
    await queryPostgres('DELETE FROM payment_attempts WHERE payment_id IN (SELECT id FROM payments WHERE user_id IN ($1, $2))', [testUser1Id, testUser2Id]);
    await queryPostgres('DELETE FROM refunds WHERE user_id IN ($1, $2)', [testUser1Id, testUser2Id]);
    await queryPostgres('DELETE FROM payments WHERE user_id IN ($1, $2)', [testUser1Id, testUser2Id]);
    await queryPostgres('DELETE FROM wallet_transactions WHERE wallet_id IN ($1, $2)', [testUser1Id, testUser2Id]);
    await queryPostgres('DELETE FROM wallets WHERE user_id IN ($1, $2)', [testUser1Id, testUser2Id]);
    await queryPostgres('DELETE FROM users WHERE id IN ($1, $2)', [testUser1Id, testUser2Id]);
  }
  setTimeout(() => process.exit(0), 100);
});

// -----------------------------------------------------------------------------
// 1. Order Creation & PostgreSQL Persistence
// -----------------------------------------------------------------------------
test('1. Razorpay Order Creation: Converts INR to paise and stores in PostgreSQL', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 500,
    currency: 'INR',
    purpose: 'wallet_topup',
    description: 'Wallet recharge ₹500',
  });

  assert.ok(order.orderId);
  assert.ok(order.paymentId);
  assert.equal(order.amount, 500);
  assert.equal(order.currency, 'INR');
  assert.equal(order.status, 'pending');
  assert.equal(order.keyId, getRazorpayKeyId());

  // Verify in PostgreSQL payments table
  const paymentRow = await queryPostgresSingle('SELECT * FROM payments WHERE id = $1', [order.paymentId]);
  assert.ok(paymentRow);
  assert.equal(paymentRow.status, 'pending');
  assert.equal(paymentRow.gateway, 'razorpay');
  assert.equal(paymentRow.order_id, order.orderId);
  assert.equal(Number(paymentRow.amount), 500);

  // Verify initial attempt recorded
  const attemptRow = await queryPostgresSingle('SELECT * FROM payment_attempts WHERE payment_id = $1', [order.paymentId]);
  assert.ok(attemptRow);
  assert.equal(attemptRow.status, 'initiated');
  assert.equal(attemptRow.gateway, 'razorpay');
});

// -----------------------------------------------------------------------------
// 2. Amount Validation
// -----------------------------------------------------------------------------
test('2. Amount Validation: Rejects zero, negative, and excessive amounts', async () => {
  await assert.rejects(
    async () => {
      await PaymentsService.createOrder({
        userId: testUser1Id,
        amount: 0,
      });
    },
    { message: /Amount must be greater than zero/ }
  );

  await assert.rejects(
    async () => {
      await PaymentsService.createOrder({
        userId: testUser1Id,
        amount: -50,
      });
    },
    { message: /Amount must be greater than zero/ }
  );

  await assert.rejects(
    async () => {
      await PaymentsService.createOrder({
        userId: testUser1Id,
        amount: 200000,
      });
    },
    { message: /Recharge amount exceeds maximum limit of ₹100,000/ }
  );
});

// -----------------------------------------------------------------------------
// 3. Currency Validation
// -----------------------------------------------------------------------------
test('3. Currency Validation: Rejects unsupported currencies', async () => {
  await assert.rejects(
    async () => {
      await PaymentsService.createOrder({
        userId: testUser1Id,
        amount: 500,
        currency: 'USD',
      });
    },
    { message: /Unsupported currency: USD. Only INR is supported./ }
  );
});

// -----------------------------------------------------------------------------
// 4. Idempotency Guard on Order Creation
// -----------------------------------------------------------------------------
test('4. Idempotency Guard: Repeated request with same idempotencyKey returns same order', async () => {
  const idemKey = `idem_order_${Date.now()}`;

  const order1 = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 300,
    idempotencyKey: idemKey,
  });

  const order2 = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 300,
    idempotencyKey: idemKey,
  });

  assert.equal(order1.orderId, order2.orderId);
  assert.equal(order1.paymentId, order2.paymentId);
  assert.equal(order1.amount, order2.amount);

  // Verify only 1 payment row was created
  const countRow = await queryPostgresSingle(
    'SELECT COUNT(*)::int AS count FROM payments WHERE idempotency_key = $1',
    [idemKey]
  );
  assert.equal(countRow.count, 1);
});

// -----------------------------------------------------------------------------
// 5. Payment Signature Verification (HMAC SHA256) & Wallet Credit
// -----------------------------------------------------------------------------
test('5. Payment Signature Verification: Valid HMAC SHA256 marks paid and credits wallet', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 250,
    currency: 'INR',
  });

  const gatewayPaymentId = `pay_valid_${Date.now()}`;
  const validSignature = crypto
    .createHmac('sha256', TEST_RAZORPAY_SECRET)
    .update(`${order.orderId}|${gatewayPaymentId}`)
    .digest('hex');

  const verifyRes = await PaymentsService.verifyPayment({
    userId: testUser1Id,
    orderId: order.orderId,
    paymentId: gatewayPaymentId,
    signature: validSignature,
  });

  assert.equal(verifyRes.alreadyPaid, false);
  assert.equal(verifyRes.amount, 250);
  assert.equal(verifyRes.paymentId, gatewayPaymentId);
  assert.ok(verifyRes.newBalance >= 250);

  // Verify PostgreSQL state
  const updatedPayment = await queryPostgresSingle('SELECT * FROM payments WHERE id = $1', [order.paymentId]);
  assert.equal(updatedPayment.status, 'paid');
  assert.equal(updatedPayment.payment_id, gatewayPaymentId);
  assert.equal(updatedPayment.signature, validSignature);
  assert.equal(updatedPayment.gateway_status, 'captured');

  // Verify wallet transaction ledger
  const tx = await queryPostgresSingle(
    'SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_id = $2',
    [testUser1Id, order.paymentId]
  );
  assert.ok(tx);
  assert.equal(Number(tx.amount), 250);
  assert.equal(tx.type, 'credit');
});

// -----------------------------------------------------------------------------
// 6. Invalid Signature Protection
// -----------------------------------------------------------------------------
test('6. Invalid Signature: Tampered signature is rejected and does NOT credit wallet', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 1000,
  });

  const walletBefore = await WalletService.getWallet(testUser1Id);

  await assert.rejects(
    async () => {
      await PaymentsService.verifyPayment({
        userId: testUser1Id,
        orderId: order.orderId,
        paymentId: `pay_tampered_${Date.now()}`,
        signature: 'invalid_forged_signature_hex_1234567890abcdef',
      });
    },
    { message: /Invalid payment signature/ }
  );

  // Verify wallet was NOT credited
  const walletAfter = await WalletService.getWallet(testUser1Id);
  assert.equal(walletAfter.balance, walletBefore.balance);

  // Verify attempt logged as failed
  const attempt = await queryPostgresSingle('SELECT * FROM payment_attempts WHERE payment_id = $1', [order.paymentId]);
  assert.equal(attempt.status, 'failed');
});

// -----------------------------------------------------------------------------
// 7. Cross-User Authorization Protection
// -----------------------------------------------------------------------------
test('7. Cross-User Authorization: User B cannot verify User A payment', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 150,
  });

  await assert.rejects(
    async () => {
      await PaymentsService.verifyPayment({
        userId: testUser2Id, // User 2 trying to verify User 1 payment
        orderId: order.orderId,
        paymentId: `pay_hack_${Date.now()}`,
        signature: 'mock_sig_123',
      });
    },
    { message: /Unauthorized: Payment does not belong to this user/ }
  );
});

// -----------------------------------------------------------------------------
// 8. Duplicate Payment Verification (Idempotency)
// -----------------------------------------------------------------------------
test('8. Duplicate Payment Verification: Repeated verify call returns cached state without duplicate credit', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 100,
  });

  const gatewayPaymentId = `pay_dup_${Date.now()}`;
  const validSignature = crypto
    .createHmac('sha256', TEST_RAZORPAY_SECRET)
    .update(`${order.orderId}|${gatewayPaymentId}`)
    .digest('hex');

  // First verify
  const res1 = await PaymentsService.verifyPayment({
    userId: testUser1Id,
    orderId: order.orderId,
    paymentId: gatewayPaymentId,
    signature: validSignature,
  });
  assert.equal(res1.alreadyPaid, false);

  const balanceAfterFirst = res1.newBalance;

  // Second verify (duplicate callback from client)
  const res2 = await PaymentsService.verifyPayment({
    userId: testUser1Id,
    orderId: order.orderId,
    paymentId: gatewayPaymentId,
    signature: validSignature,
  });

  assert.equal(res2.alreadyPaid, true);
  assert.equal(res2.newBalance, balanceAfterFirst, 'Balance MUST NOT increase on duplicate verification');

  // Verify only 1 credit transaction in ledger
  const txCount = await queryPostgresSingle(
    'SELECT COUNT(*)::int AS count FROM wallet_transactions WHERE wallet_id = $1 AND reference_id = $2',
    [testUser1Id, order.paymentId]
  );
  assert.equal(txCount.count, 1);
});

// -----------------------------------------------------------------------------
// 9. Webhook Signature Verification (Raw Body)
// -----------------------------------------------------------------------------
test('9. Webhook Signature Verification: Valid raw payload signature is accepted', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser2Id,
    amount: 400,
  });

  const webhookPayload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_hook_${Date.now()}`,
          order_id: order.orderId,
          amount: 40000,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
  });

  const validWebhookSig = crypto
    .createHmac('sha256', TEST_WEBHOOK_SECRET)
    .update(webhookPayload)
    .digest('hex');

  const webhookRes = await PaymentsService.handleWebhook({
    rawBody: Buffer.from(webhookPayload, 'utf8'),
    headers: {
      'x-razorpay-signature': validWebhookSig,
    },
  });

  assert.equal(webhookRes.success, true);
  assert.equal(webhookRes.event, 'payment.captured');

  // Verify wallet credited for user 2
  const wallet = await WalletService.getWallet(testUser2Id);
  assert.equal(wallet.balance, 400);
});

// -----------------------------------------------------------------------------
// 10. Invalid Webhook Signature Protection
// -----------------------------------------------------------------------------
test('10. Invalid Webhook Signature: Forged webhook signature is rejected with error', async () => {
  const fakePayload = JSON.stringify({ event: 'payment.captured' });

  await assert.rejects(
    async () => {
      await PaymentsService.handleWebhook({
        rawBody: Buffer.from(fakePayload, 'utf8'),
        headers: {
          'x-razorpay-signature': 'forged_invalid_signature_hex_123',
        },
      });
    },
    { message: /Invalid webhook signature/ }
  );
});

// -----------------------------------------------------------------------------
// 11. Duplicate Webhook Protection (Idempotency)
// -----------------------------------------------------------------------------
test('11. Duplicate Webhook: Repeated webhook delivery does not credit wallet twice', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser2Id,
    amount: 200,
  });

  const webhookPayload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_hook_dup_${Date.now()}`,
          order_id: order.orderId,
          amount: 20000,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
  });

  const validWebhookSig = crypto
    .createHmac('sha256', TEST_WEBHOOK_SECRET)
    .update(webhookPayload)
    .digest('hex');

  // First webhook
  await PaymentsService.handleWebhook({
    rawBody: Buffer.from(webhookPayload, 'utf8'),
    headers: { 'x-razorpay-signature': validWebhookSig },
  });

  const balanceAfterFirst = (await WalletService.getWallet(testUser2Id)).balance;

  // Second duplicate webhook delivery
  await PaymentsService.handleWebhook({
    rawBody: Buffer.from(webhookPayload, 'utf8'),
    headers: { 'x-razorpay-signature': validWebhookSig },
  });

  const balanceAfterSecond = (await WalletService.getWallet(testUser2Id)).balance;
  assert.equal(balanceAfterSecond, balanceAfterFirst, 'Balance must not change on duplicate webhook');
});

// -----------------------------------------------------------------------------
// 12. Failed Payment Lifecycle
// -----------------------------------------------------------------------------
test('12. Failed Payment Lifecycle: payment.failed event marks payment and attempt failed', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 150,
  });

  const failedPayload = JSON.stringify({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: `pay_failed_${Date.now()}`,
          order_id: order.orderId,
          amount: 15000,
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Payment was declined by issuing bank',
        },
      },
    },
  });

  const validSig = crypto
    .createHmac('sha256', TEST_WEBHOOK_SECRET)
    .update(failedPayload)
    .digest('hex');

  await PaymentsService.handleWebhook({
    rawBody: Buffer.from(failedPayload, 'utf8'),
    headers: { 'x-razorpay-signature': validSig },
  });

  const payment = await queryPostgresSingle('SELECT * FROM payments WHERE id = $1', [order.paymentId]);
  assert.equal(payment.status, 'failed');
  assert.equal(payment.gateway_status, 'failed');

  const attempt = await queryPostgresSingle('SELECT * FROM payment_attempts WHERE payment_id = $1', [order.paymentId]);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.error_code, 'BAD_REQUEST_ERROR');
});

// -----------------------------------------------------------------------------
// 13. Refund Creation & Reconciliation
// -----------------------------------------------------------------------------
test('13. Refund Creation & Reconciliation: Initiates refund and updates PostgreSQL ledger', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUser1Id,
    amount: 100,
  });

  const paymentId = `pay_to_refund_${Date.now()}`;
  const validSig = crypto
    .createHmac('sha256', TEST_RAZORPAY_SECRET)
    .update(`${order.orderId}|${paymentId}`)
    .digest('hex');

  await PaymentsService.verifyPayment({
    userId: testUser1Id,
    orderId: order.orderId,
    paymentId,
    signature: validSig,
  });

  const refundRes = await PaymentsService.processRefund({
    paymentId: order.paymentId,
    amount: 100,
    reason: 'Customer requested refund',
    processedBy: testUser1Id,
  });

  assert.ok(refundRes.refundId);
  assert.ok(refundRes.gatewayRefundId);
  assert.equal(refundRes.status, 'processed');

  const refundRow = await queryPostgresSingle('SELECT * FROM refunds WHERE id = $1', [refundRes.refundId]);
  assert.ok(refundRow);
  assert.equal(Number(refundRow.amount), 100);
  assert.equal(refundRow.gateway_refund_id, refundRes.gatewayRefundId);
});

// -----------------------------------------------------------------------------
// 14. PostgreSQL Financial Ledger Consistency
// -----------------------------------------------------------------------------
test('14. PostgreSQL Financial Ledger: Wallet balance strictly matches sum of ledger transactions', async () => {
  const wallet = await WalletService.getWallet(testUser1Id);
  
  const sumRow = await queryPostgresSingle(
    `SELECT 
       COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0)::numeric AS expected_balance
     FROM wallet_transactions 
     WHERE wallet_id = $1`,
    [testUser1Id]
  );

  assert.equal(Number(wallet.balance), Number(sumRow.expected_balance), 'Wallet balance must strictly match ledger sum');
});
