import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { queryPostgres, queryPostgresSingle, connectMongo, pgPool } from '../src/config/db.js';
import { WalletService } from '../src/services/wallet.service.js';
import { PaymentsService } from '../src/services/payments.service.js';
import { BillingService } from '../src/services/billing.service.js';
import { PayoutService } from '../src/services/payout.service.js';
import { CallsService } from '../src/services/calls.service.js';
import { ChatMessage } from '../src/models/mongo/ChatMessage.js';
import { CallSession } from '../src/models/mongo/CallSession.js';
import { VideoCallSession } from '../src/models/mongo/VideoCallSession.js';
import { hashPassword } from '../src/auth/jwt.js';

let testUserAId = '';
let testUserBId = '';
let testAstrologerId = '';
let testConsultationId = '';
let testPaymentOrderId = '';
let testPaymentId = '';

before(async () => {
  console.log('[PHASE 2 TEST:SETUP] Initializing test fixtures in PostgreSQL and MongoDB...');
  await connectMongo();

  // Create Test User A
  const passHash = await hashPassword('TestPass@123');
  const userA = await queryPostgresSingle(
    `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
     VALUES ($1, $2, $3, 'customer', 'active', true)
     RETURNING id`,
    [`p2_usera_${Date.now()}@test.com`, `+9198${Math.floor(10000000 + Math.random() * 90000000)}`, passHash]
  );
  testUserAId = userA.id;

  // Create Test User B
  const userB = await queryPostgresSingle(
    `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
     VALUES ($1, $2, $3, 'customer', 'active', true)
     RETURNING id`,
    [`p2_userb_${Date.now()}@test.com`, `+9197${Math.floor(10000000 + Math.random() * 90000000)}`, passHash]
  );
  testUserBId = userB.id;

  // Create Test Astrologer User & Profile
  const astroUser = await queryPostgresSingle(
    `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
     VALUES ($1, $2, $3, 'astrologer', 'active', true)
     RETURNING id`,
    [`p2_astro_${Date.now()}@test.com`, `+9196${Math.floor(10000000 + Math.random() * 90000000)}`, passHash]
  );
  testAstrologerId = astroUser.id;

  await queryPostgres(
    `INSERT INTO astrologer_profiles (id, display_name, per_minute_rate, hourly_rate, is_online, is_busy, is_verified)
     VALUES ($1, 'Acharya Phase2 Test', 30.00, 1800.00, true, false, true)
     ON CONFLICT (id) DO UPDATE SET per_minute_rate = 30.00, is_online = true`,
    [testAstrologerId]
  );

  // Initialize wallets in PostgreSQL for test users
  await WalletService.getWallet(testUserAId);
  await WalletService.getWallet(testUserBId);

  console.log('[PHASE 2 TEST:SETUP] Fixtures ready. UserA:', testUserAId, 'Astro:', testAstrologerId);
});

after(async () => {
  console.log('[PHASE 2 TEST:CLEANUP] Cleaning up test connections...');
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (err) {
    console.error('[PHASE 2 TEST:CLEANUP] Cleanup error:', err);
  }
  try { await pgPool.end(); } catch {}
  try {
    const { closeRedis } = await import('../src/config/redis.js');
    await closeRedis();
  } catch {}
  setTimeout(() => process.exit(0), 100).unref();
});

// -----------------------------------------------------------------------------
// 1. Wallet Creation
// -----------------------------------------------------------------------------
test('1. Wallet Creation: Initializes with 0.00 balance in PostgreSQL', async () => {
  const wallet = await WalletService.getWallet(testUserAId);
  assert.equal(typeof wallet.balance, 'number');
  assert.equal(wallet.balance, 0.0);
  assert.equal(wallet.currency, 'INR');

  // Verify directly in PostgreSQL
  const pgWallet = await queryPostgresSingle('SELECT * FROM wallets WHERE user_id = $1', [testUserAId]);
  assert.ok(pgWallet, 'Wallet row must exist in PostgreSQL wallets table');
  assert.equal(Number(pgWallet.balance), 0.0);
});

// -----------------------------------------------------------------------------
// 2. Wallet Recharge Order Creation
// -----------------------------------------------------------------------------
test('2. Wallet Recharge: Creates payment order and payment_attempts record', async () => {
  const order = await PaymentsService.createOrder({
    userId: testUserAId,
    amount: 600.0,
    currency: 'INR',
    description: 'Test Wallet Recharge',
  });

  assert.ok(order.orderId);
  assert.equal(order.amount, 600.0);
  testPaymentOrderId = order.orderId;

  // Direct PostgreSQL check
  const paymentRow = await queryPostgresSingle('SELECT * FROM payments WHERE order_id = $1', [order.orderId]);
  assert.ok(paymentRow);
  assert.equal(paymentRow.status, 'pending');
  assert.equal(Number(paymentRow.amount), 600.0);
  testPaymentId = paymentRow.id;

  const attemptRow = await queryPostgresSingle('SELECT * FROM payment_attempts WHERE payment_id = $1', [testPaymentId]);
  assert.ok(attemptRow, 'Payment attempt must be recorded in payment_attempts table');
  assert.equal(attemptRow.status, 'initiated');
});

// -----------------------------------------------------------------------------
// 3. Successful Payment Verification
// -----------------------------------------------------------------------------
test('3. Successful Payment: Updates payment status to paid and credits wallet atomically', async () => {
  const verifyRes = await PaymentsService.verifyPayment({
    userId: testUserAId,
    orderId: testPaymentOrderId,
    paymentId: `pay_test_${Date.now()}`,
    signature: 'mock_sig_123',
  });

  assert.equal(verifyRes.alreadyPaid, false);
  assert.equal(verifyRes.newBalance, 600.0);

  // Verify directly in PostgreSQL
  const updatedPayment = await queryPostgresSingle('SELECT * FROM payments WHERE id = $1', [testPaymentId]);
  assert.equal(updatedPayment.status, 'paid');

  const attempt = await queryPostgresSingle('SELECT * FROM payment_attempts WHERE payment_id = $1', [testPaymentId]);
  assert.equal(attempt.status, 'successful');

  const updatedWallet = await queryPostgresSingle('SELECT * FROM wallets WHERE user_id = $1', [testUserAId]);
  assert.equal(Number(updatedWallet.balance), 600.0);

  const tx = await queryPostgresSingle(
    'SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_id = $2',
    [testUserAId, testPaymentId]
  );
  assert.ok(tx);
  assert.equal(tx.type, 'credit');
  assert.equal(Number(tx.amount), 600.0);
  assert.equal(Number(tx.balance_after), 600.0);
});

// -----------------------------------------------------------------------------
// 4. Failed Payment Handling
// -----------------------------------------------------------------------------
test('4. Failed Payment: Non-existent order rejects with clean error', async () => {
  await assert.rejects(
    async () => {
      await PaymentsService.verifyPayment({
        userId: testUserAId,
        orderId: 'order_non_existent_999999',
      });
    },
    { message: /Payment order not found/ }
  );
});

// -----------------------------------------------------------------------------
// 5. Duplicate Payment Processing Guard
// -----------------------------------------------------------------------------
test('5. Duplicate Payment: Subsequent verify call does NOT credit wallet twice', async () => {
  const duplicateRes = await PaymentsService.verifyPayment({
    userId: testUserAId,
    orderId: testPaymentOrderId,
  });

  assert.equal(duplicateRes.alreadyPaid, true);
  assert.equal(duplicateRes.newBalance, 600.0);

  // Verify wallet balance is STILL exactly 600.00
  const pgWallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [testUserAId]);
  assert.equal(Number(pgWallet.balance), 600.0);
});

// -----------------------------------------------------------------------------
// 6. Idempotency Key Handling
// -----------------------------------------------------------------------------
test('6. Idempotency: Creating order with duplicate idempotencyKey returns existing order', async () => {
  const idemKey = `idem_${Date.now()}`;
  const order1 = await PaymentsService.createOrder({
    userId: testUserAId,
    amount: 150.0,
    idempotencyKey: idemKey,
  });

  const order2 = await PaymentsService.createOrder({
    userId: testUserAId,
    amount: 150.0,
    idempotencyKey: idemKey,
  });

  assert.equal(order1.orderId, order2.orderId);

  const countRes = await queryPostgresSingle(
    'SELECT COUNT(*)::int AS count FROM payments WHERE idempotency_key = $1',
    [idemKey]
  );
  assert.equal(countRes.count, 1, 'Duplicate idempotency key must not create a duplicate row');
});

// -----------------------------------------------------------------------------
// 7. Refund Processing
// -----------------------------------------------------------------------------
test('7. Refund: Reverses payment atomically and records in refunds and wallet ledger', async () => {
  const refundRes = await PaymentsService.processRefund({
    paymentId: testPaymentId,
    amount: 100.0,
    reason: 'Customer Satisfaction Guarantee',
    idempotencyKey: `rfnd_key_${Date.now()}`,
  });

  assert.ok(refundRes.refundId);
  assert.equal(refundRes.status, 'processed');

  // Verify directly in PostgreSQL
  const refundRow = await queryPostgresSingle('SELECT * FROM refunds WHERE id = $1', [refundRes.refundId]);
  assert.ok(refundRow);
  assert.equal(Number(refundRow.amount), 100.0);
  assert.equal(refundRow.status, 'processed');

  // Verify wallet balance decremented by 100 to 500
  const pgWallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [testUserAId]);
  assert.equal(Number(pgWallet.balance), 500.0);

  const refundTx = await queryPostgresSingle(
    "SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_type = 'refund'",
    [testUserAId]
  );
  assert.ok(refundTx);
  assert.equal(refundTx.type, 'debit');
  assert.equal(Number(refundTx.amount), 100.0);
});

// -----------------------------------------------------------------------------
// 8. Consultation Billing
// -----------------------------------------------------------------------------
test('8. Consultation Billing: Ends consultation, records consultation_billing and invoice', async () => {
  // Create Consultation
  const cons = await queryPostgresSingle(
    `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute, start_time)
     VALUES ($1, $2, 'chat', 'ACCEPTED', 30.00, NOW() - INTERVAL '5 minutes')
     RETURNING *`,
    [testUserAId, testAstrologerId]
  );
  testConsultationId = cons.id;

  const billResult = await BillingService.endAndBillConsultation({
    consultationId: testConsultationId,
    callerUserId: testAstrologerId,
    callerRole: 'astrologer',
    durationSeconds: 300, // 5 minutes -> 5 * 30 = 150.00
  });

  assert.ok(billResult.billingId);
  assert.equal(billResult.billedMinutes, 5);
  assert.equal(billResult.grossAmount, 150.0);
  assert.equal(billResult.platformFee, 30.0); // 20% of 150
  assert.equal(billResult.astrologerEarnings, 120.0); // 80% of 150

  // Direct PostgreSQL validation
  const billingRow = await queryPostgresSingle(
    'SELECT * FROM consultation_billing WHERE id = $1',
    [billResult.billingId]
  );
  assert.ok(billingRow);
  assert.equal(Number(billingRow.gross_amount), 150.0);
  assert.equal(Number(billingRow.platform_fee), 30.0);
  assert.equal(Number(billingRow.astrologer_earnings), 120.0);

  const invoiceRow = await queryPostgresSingle(
    "SELECT * FROM invoices WHERE reference_id = $1 AND reference_type = 'consultation'",
    [testConsultationId]
  );
  assert.ok(invoiceRow, 'Invoice row must be generated in invoices table');
  assert.equal(Number(invoiceRow.total_amount), 150.0);

  const consRow = await queryPostgresSingle('SELECT * FROM consultations WHERE id = $1', [testConsultationId]);
  assert.equal(consRow.state, 'ENDED');
  assert.equal(Number(consRow.total_amount), 150.0);
});

// -----------------------------------------------------------------------------
// 9. Wallet Debit Verification
// -----------------------------------------------------------------------------
test('9. Wallet Debit: Customer wallet debited exactly 150.00 with ledger record', async () => {
  // Previous balance was 500.0, minus 150.0 = 350.0
  const wallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [testUserAId]);
  assert.equal(Number(wallet.balance), 350.0);

  const tx = await queryPostgresSingle(
    "SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_type = 'consultation' AND reference_id = $2",
    [testUserAId, testConsultationId]
  );
  assert.ok(tx);
  assert.equal(tx.type, 'debit');
  assert.equal(Number(tx.amount), 150.0);
  assert.equal(Number(tx.balance_after), 350.0);
});

// -----------------------------------------------------------------------------
// 10. Insufficient Balance Protection
// -----------------------------------------------------------------------------
test('10. Insufficient Balance: Debiting more than available balance throws error and prevents negative balance', async () => {
  await assert.rejects(
    async () => {
      await WalletService.debitWallet(testUserAId, 9999.0, 'test_overdraw');
    },
    { message: /Insufficient wallet balance/ }
  );

  // Balance must remain strictly non-negative and untouched
  const wallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [testUserAId]);
  assert.equal(Number(wallet.balance), 350.0);
});

// -----------------------------------------------------------------------------
// 11. Concurrent Wallet Operations (Row Locking Verification)
// -----------------------------------------------------------------------------
test('11. Concurrent Wallet Operations: Parallel debits and credits maintain perfect balance consistency', async () => {
  const initialWallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [testUserAId]);
  const initialBalance = Number(initialWallet.balance);

  // Run 5 parallel credits of 20 and 5 parallel debits of 10
  const operations = [
    WalletService.creditWallet(testUserAId, 20.0, 'concurrent_credit_1'),
    WalletService.creditWallet(testUserAId, 20.0, 'concurrent_credit_2'),
    WalletService.creditWallet(testUserAId, 20.0, 'concurrent_credit_3'),
    WalletService.creditWallet(testUserAId, 20.0, 'concurrent_credit_4'),
    WalletService.creditWallet(testUserAId, 20.0, 'concurrent_credit_5'),
    WalletService.debitWallet(testUserAId, 10.0, 'concurrent_debit_1'),
    WalletService.debitWallet(testUserAId, 10.0, 'concurrent_debit_2'),
    WalletService.debitWallet(testUserAId, 10.0, 'concurrent_debit_3'),
    WalletService.debitWallet(testUserAId, 10.0, 'concurrent_debit_4'),
    WalletService.debitWallet(testUserAId, 10.0, 'concurrent_debit_5'),
  ];

  await Promise.all(operations);

  // Net change: + (5 * 20) - (5 * 10) = + 100 - 50 = + 50
  const finalWallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [testUserAId]);
  assert.equal(Number(finalWallet.balance), initialBalance + 50.0);
});

// -----------------------------------------------------------------------------
// 12. Commission Calculation
// -----------------------------------------------------------------------------
test('12. Commission Calculation: Platform commission is verified at exact 20% rate in commissions table', async () => {
  const comm = await queryPostgresSingle(
    "SELECT * FROM commissions WHERE reference_id = $1 AND reference_type = 'consultation'",
    [testConsultationId]
  );
  assert.ok(comm);
  assert.equal(Number(comm.gross_amount), 150.0);
  assert.equal(Number(comm.commission_rate), 20.0);
  assert.equal(Number(comm.platform_fee), 30.0);
  assert.equal(Number(comm.provider_net_amount), 120.0);
});

// -----------------------------------------------------------------------------
// 13. Astrologer Earnings Ledger
// -----------------------------------------------------------------------------
test('13. Astrologer Earnings: Provider earnings ledger credited with 120.00 available balance', async () => {
  const earnings = await queryPostgresSingle(
    'SELECT * FROM provider_earnings WHERE provider_id = $1',
    [testAstrologerId]
  );
  assert.ok(earnings);
  assert.ok(Number(earnings.total_earned) >= 120.0);
  assert.ok(Number(earnings.available_balance) >= 120.0);
});

// -----------------------------------------------------------------------------
// 14. Payout Creation
// -----------------------------------------------------------------------------
test('14. Payout Creation: Locks requested amount from available to pending balance', async () => {
  const initialEarnings = await queryPostgresSingle(
    'SELECT * FROM provider_earnings WHERE provider_id = $1',
    [testAstrologerId]
  );
  const initialAvail = Number(initialEarnings.available_balance);

  const payoutReq = await PayoutService.requestPayout(testAstrologerId, 50.0);
  assert.ok(payoutReq);
  assert.equal(payoutReq.status, 'REQUESTED');
  assert.equal(Number(payoutReq.amount), 50.0);

  const updatedEarnings = await queryPostgresSingle(
    'SELECT * FROM provider_earnings WHERE provider_id = $1',
    [testAstrologerId]
  );
  assert.equal(Number(updatedEarnings.available_balance), initialAvail - 50.0);
  assert.equal(Number(updatedEarnings.pending_payout_amount), 50.0);
});

// -----------------------------------------------------------------------------
// 15. Call Session Creation (MongoDB)
// -----------------------------------------------------------------------------
test('15. Call Session Creation: Logs call session document in MongoDB referencing PostgreSQL IDs', async () => {
  if (mongoose.connection.readyState !== 1) return;
  const session = await CallsService.logCallSession({
    consultationId: testConsultationId,
    userId: testUserAId,
    astrologerId: testAstrologerId,
    type: 'voice',
    status: 'connected',
    durationSeconds: 180,
    event: 'call_connected',
  });

  assert.ok(session);
  assert.equal(session.consultationId, testConsultationId);
  assert.equal(session.userId, testUserAId);
  assert.equal(session.astrologerId, testAstrologerId);
  assert.equal(session.status, 'connected');

  const mongoDoc = await CallSession.findOne({ consultationId: testConsultationId });
  assert.ok(mongoDoc);
  assert.equal(mongoDoc.durationSeconds, 180);
});

// -----------------------------------------------------------------------------
// 16. Video Session Creation (MongoDB)
// -----------------------------------------------------------------------------
test('16. Video Session Creation: Logs video call session document in MongoDB', async () => {
  if (mongoose.connection.readyState !== 1) return;
  const sessionId = `vsession_${Date.now()}`;
  const videoDoc = await CallsService.logVideoSession({
    consultationId: testConsultationId,
    sessionId,
    webrtcRoomId: `room_${testConsultationId}`,
    status: 'active',
    qualityMetrics: { bitrate: 1200, packetLoss: 0.01, resolution: '720p', latencyMs: 45 },
  });

  assert.ok(videoDoc);
  assert.equal(videoDoc.sessionId, sessionId);
  assert.equal(videoDoc.webrtcRoomId, `room_${testConsultationId}`);

  const found = await VideoCallSession.findOne({ sessionId });
  assert.ok(found);
  assert.equal(found.qualityMetrics[0].resolution, '720p');
});

// -----------------------------------------------------------------------------
// 17. Chat Persistence in MongoDB referencing PostgreSQL UUIDs
// -----------------------------------------------------------------------------
test('17. Chat Persistence: Chat messages persist in MongoDB with PostgreSQL UUID foreign keys', async () => {
  if (mongoose.connection.readyState !== 1) return;
  const clientMessageId = `p2_msg_${Date.now()}`;
  const msgDoc = await ChatMessage.create({
    _id: clientMessageId,
    conversationId: testConsultationId,
    consultationId: testConsultationId,
    senderId: testUserAId,
    senderRole: 'customer',
    recipientId: testAstrologerId,
    messageType: 'text',
    content: 'Namaste Astrologer ji, can you read my chart?',
    status: 'sent',
    messageId: clientMessageId,
  });

  assert.ok(msgDoc);
  const found = await ChatMessage.findOne({ _id: clientMessageId });
  assert.ok(found);
  assert.equal(found.consultationId, testConsultationId);
  assert.equal(found.senderId, testUserAId);
  assert.equal(found.recipientId, testAstrologerId);
  assert.equal(found.content, 'Namaste Astrologer ji, can you read my chart?');
});

// -----------------------------------------------------------------------------
// 18. Cross-User Authorization Barrier
// -----------------------------------------------------------------------------
test('18. Cross-User Authorization: User B cannot verify or tamper with User A payments or consultations', async () => {
  // User B tries to verify User A's payment
  await assert.rejects(
    async () => {
      await PaymentsService.verifyPayment({
        userId: testUserBId, // wrong user!
        orderId: testPaymentOrderId,
      });
    },
    { message: /Unauthorized: Payment does not belong to this user/ }
  );

  // User B tries to end and bill User A's consultation
  await assert.rejects(
    async () => {
      await BillingService.endAndBillConsultation({
        consultationId: testConsultationId,
        callerUserId: testUserBId, // wrong user!
        callerRole: 'customer',
      });
    },
    { message: /Unauthorized: You are not authorized to end or bill this consultation/ }
  );
});

// -----------------------------------------------------------------------------
// PHASE 1 REGRESSION TESTS: Chat Reliability & Deduplication
// -----------------------------------------------------------------------------
test('Phase 1 Regression: 4 repeated "hi" messages are persisted as 4 distinct records by ID', async () => {
  if (mongoose.connection.readyState !== 1) return;
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const mId = `p1_repeat_hi_${Date.now()}_${i}_${Math.random().toString(36).substring(7)}`;
    ids.push(mId);
    await ChatMessage.create({
      _id: mId,
      conversationId: testConsultationId,
      consultationId: testConsultationId,
      senderId: testAstrologerId,
      senderRole: 'astrologer',
      recipientId: testUserAId,
      messageType: 'text',
      content: 'hi',
      status: 'sent',
      messageId: mId,
    });
  }

  const repeatedDocs = await ChatMessage.find({ _id: { $in: ids } });
  assert.equal(repeatedDocs.length, 4, 'All 4 repeated "hi" messages must exist as separate records');
});

test('Phase 1 Regression: 10 rapid messages (ASTRO_1..ASTRO_10) persist in exact chronological order', async () => {
  if (mongoose.connection.readyState !== 1) return;
  const rapidIds: string[] = [];
  const baseTime = Date.now();
  for (let i = 1; i <= 10; i++) {
    const mId = `p1_rapid_${baseTime}_${String(i).padStart(2, '0')}`;
    rapidIds.push(mId);
    await ChatMessage.create({
      _id: mId,
      conversationId: testConsultationId,
      consultationId: testConsultationId,
      senderId: testAstrologerId,
      senderRole: 'astrologer',
      recipientId: testUserAId,
      messageType: 'text',
      content: `ASTRO_${i}`,
      status: 'sent',
      messageId: mId,
      createdAt: new Date(baseTime + i * 50),
    });
  }

  const rapidDocs = await ChatMessage.find({ _id: { $in: rapidIds } }).sort({ createdAt: 1 });
  assert.equal(rapidDocs.length, 10, 'All 10 rapid messages must be persisted');
  for (let i = 0; i < 10; i++) {
    assert.equal(rapidDocs[i].content, `ASTRO_${i + 1}`);
  }
});
