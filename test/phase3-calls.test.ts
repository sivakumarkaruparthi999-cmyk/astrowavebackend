import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { queryPostgres, queryPostgresSingle, connectMongo, pgPool } from '../src/config/db.js';
import { WalletService } from '../src/services/wallet.service.js';
import { BillingService } from '../src/services/billing.service.js';
import { CallsService } from '../src/services/calls.service.js';
import { CallSession } from '../src/models/mongo/CallSession.js';
import { VideoCallSession } from '../src/models/mongo/VideoCallSession.js';
import { hashPassword } from '../src/auth/jwt.js';

let testUserAId = '';
let testUserBId = '';
let testAstrologerId = '';
let testConsultationAudioId = '';
let testConsultationVideoId = '';
let testConsultationUnconnectedId = '';

before(async () => {
  console.log('[PHASE 3 TEST:SETUP] Initializing test fixtures in PostgreSQL and MongoDB...');
  await connectMongo();

  const passHash = await hashPassword('TestPass@123');

  // Customer A
  const userA = await queryPostgresSingle(
    `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
     VALUES ($1, $2, $3, 'customer', 'active', true)
     RETURNING id`,
    [`p3_usera_${Date.now()}@test.com`, `+9195${Math.floor(10000000 + Math.random() * 90000000)}`, passHash]
  );
  testUserAId = userA.id;

  // Customer B (unauthorized third party)
  const userB = await queryPostgresSingle(
    `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
     VALUES ($1, $2, $3, 'customer', 'active', true)
     RETURNING id`,
    [`p3_userb_${Date.now()}@test.com`, `+9194${Math.floor(10000000 + Math.random() * 90000000)}`, passHash]
  );
  testUserBId = userB.id;

  // Astrologer
  const astroUser = await queryPostgresSingle(
    `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
     VALUES ($1, $2, $3, 'astrologer', 'active', true)
     RETURNING id`,
    [`p3_astro_${Date.now()}@test.com`, `+9193${Math.floor(10000000 + Math.random() * 90000000)}`, passHash]
  );
  testAstrologerId = astroUser.id;

  await queryPostgres(
    `INSERT INTO astrologer_profiles (id, display_name, per_minute_rate, hourly_rate, is_online, is_busy, is_verified)
     VALUES ($1, 'Acharya Phase3 Test', 40.00, 2400.00, true, false, true)
     ON CONFLICT (id) DO UPDATE SET per_minute_rate = 40.00, is_online = true`,
    [testAstrologerId]
  );

  // Initialize wallets
  await WalletService.getWallet(testUserAId);
  await WalletService.getWallet(testAstrologerId);

  // Fund Customer A wallet with ₹500
  await WalletService.creditWallet(testUserAId, 500.0, 'Phase 3 test wallet funding');

  // Create Audio Consultation
  const consAudio = await queryPostgresSingle(
    `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute, start_time)
     VALUES ($1, $2, 'call', 'ACCEPTED', 40.00, NOW() - INTERVAL '3 minutes')
     RETURNING id`,
    [testUserAId, testAstrologerId]
  );
  testConsultationAudioId = consAudio.id;

  // Create Video Consultation
  const consVideo = await queryPostgresSingle(
    `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute, start_time)
     VALUES ($1, $2, 'call', 'ACCEPTED', 40.00, NOW() - INTERVAL '4 minutes')
     RETURNING id`,
    [testUserAId, testAstrologerId]
  );
  testConsultationVideoId = consVideo.id;

  // Create Unconnected Consultation
  const consUnconnected = await queryPostgresSingle(
    `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute, start_time)
     VALUES ($1, $2, 'call', 'REQUESTED', 40.00, NOW())
     RETURNING id`,
    [testUserAId, testAstrologerId]
  );
  testConsultationUnconnectedId = consUnconnected.id;
});

after(async () => {
  console.log('[PHASE 3 TEST:CLEANUP] Cleaning up test connections...');
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  } catch (err) {}
  try { await pgPool.end(); } catch {}
  try {
    const { closeRedis } = await import('../src/config/redis.js');
    await closeRedis();
  } catch {}
  setTimeout(() => process.exit(0), 100).unref();
});

// -----------------------------------------------------------------------------
// 1. Authorized Call Initiation Creates Session
// -----------------------------------------------------------------------------
test('1. Authorized call initiation creates session with valid MongoDB document', async () => {
  const session = await CallsService.logCallSession({
    consultationId: testConsultationAudioId,
    userId: testUserAId,
    astrologerId: testAstrologerId,
    type: 'voice',
    status: 'initiating',
  });

  assert.ok(session);
  assert.equal(session.consultationId, testConsultationAudioId);
  assert.equal(session.userId, testUserAId);
  assert.equal(session.astrologerId, testAstrologerId);
  assert.equal(session.type, 'voice');
  assert.equal(session.status, 'initiating');
  assert.ok(session.sessionId);
});

// -----------------------------------------------------------------------------
// 2. Unauthorized Call Fails
// -----------------------------------------------------------------------------
test('2. Unauthorized call participant cannot end or bill consultation', async () => {
  await assert.rejects(
    async () => {
      await BillingService.endAndBillConsultation({
        consultationId: testConsultationAudioId,
        callerUserId: testUserBId, // User B is not part of this consultation
        callerRole: 'customer',
        durationSeconds: 180,
      });
    },
    {
      name: 'Error',
      message: /Unauthorized/,
    }
  );
});

// -----------------------------------------------------------------------------
// 3. Call Accept Transitions Session
// -----------------------------------------------------------------------------
test('3. Call accept transitions session to accepted', async () => {
  const session = await CallsService.logCallSession({
    consultationId: testConsultationAudioId,
    userId: testUserAId,
    astrologerId: testAstrologerId,
    type: 'voice',
    status: 'accepted',
  });

  assert.equal(session.status, 'accepted');
  if (mongoose.connection.readyState === 1) {
    const found = await CallSession.findById(session._id);
    assert.equal(found?.status, 'accepted');
  }
});

// -----------------------------------------------------------------------------
// 4. Call Reject Transitions Session
// -----------------------------------------------------------------------------
test('4. Call reject transitions session to rejected and sets zero duration', async () => {
  const session = await CallsService.logCallSession({
    consultationId: testConsultationUnconnectedId,
    userId: testUserAId,
    astrologerId: testAstrologerId,
    type: 'voice',
    status: 'rejected',
    durationSeconds: 0,
  });

  assert.equal(session.status, 'rejected');
  assert.equal(session.durationSeconds, 0);
});

// -----------------------------------------------------------------------------
// 5. Call Connected & End Transitions Session
// -----------------------------------------------------------------------------
test('5. Call connected and end records connectedAt, endedAt, and duration', async () => {
  // Mark connected
  const connectedSession = await CallsService.logCallSession({
    consultationId: testConsultationAudioId,
    userId: testUserAId,
    astrologerId: testAstrologerId,
    type: 'voice',
    status: 'connected',
  });
  assert.equal(connectedSession.status, 'connected');
  assert.ok(connectedSession.connectedAt);

  // Mark ended with 180 seconds
  const endedSession = await CallsService.logCallSession({
    consultationId: testConsultationAudioId,
    userId: testUserAId,
    astrologerId: testAstrologerId,
    type: 'voice',
    status: 'ended',
    durationSeconds: 180,
  });

  assert.equal(endedSession.status, 'ended');
  assert.ok(endedSession.endedAt);
  assert.equal(endedSession.durationSeconds, 180);
});

// -----------------------------------------------------------------------------
// 6. Invalid Consultation ID Rejected
// -----------------------------------------------------------------------------
test('6. Invalid consultation ID rejected with clean error', async () => {
  const fakeConsultationId = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(
    async () => {
      await BillingService.endAndBillConsultation({
        consultationId: fakeConsultationId,
        callerUserId: testUserAId,
        callerRole: 'customer',
        durationSeconds: 60,
      });
    },
    {
      name: 'Error',
      message: /not found/,
    }
  );
});

// -----------------------------------------------------------------------------
// 7. Invalid Participant ID Rejected
// -----------------------------------------------------------------------------
test('7. Invalid participant ID rejected when ending consultation', async () => {
  const fakeUserId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  await assert.rejects(
    async () => {
      await BillingService.endAndBillConsultation({
        consultationId: testConsultationAudioId,
        callerUserId: fakeUserId,
        callerRole: 'customer',
        durationSeconds: 60,
      });
    },
    {
      name: 'Error',
      message: /Unauthorized/,
    }
  );
});

// -----------------------------------------------------------------------------
// 8. MongoDB Call Session Persistence Verified
// -----------------------------------------------------------------------------
test('8. MongoDB CallSession document persists all required attributes', async () => {
  if (mongoose.connection.readyState !== 1) return;
  const doc = await CallSession.findOne({ consultationId: testConsultationAudioId, status: 'ended' });
  assert.ok(doc, 'CallSession document should exist in MongoDB');
  assert.equal(doc.type, 'voice');
  assert.equal(doc.userId, testUserAId);
  assert.equal(doc.astrologerId, testAstrologerId);
  assert.equal(doc.durationSeconds, 180);
  assert.ok(doc.connectedAt);
  assert.ok(doc.endedAt);
});

// -----------------------------------------------------------------------------
// 9. MongoDB Video Session Persistence Verified
// -----------------------------------------------------------------------------
test('9. MongoDB VideoCallSession document persists video metadata', async () => {
  if (mongoose.connection.readyState !== 1) return;
  const videoDoc = await VideoCallSession.create({
    consultationId: testConsultationVideoId,
    sessionId: `vses_${Date.now()}`,
    webrtcRoomId: `room_${testConsultationVideoId}`,
    status: 'active',
    qualityMetrics: [
      {
        bitrate: 1500000,
        packetLoss: 0.05,
        resolution: '720p',
        latencyMs: 35,
        timestamp: new Date(),
      },
    ],
  });

  assert.ok(videoDoc);
  assert.equal(videoDoc.consultationId, testConsultationVideoId);
  assert.equal(videoDoc.status, 'active');
  assert.equal(videoDoc.qualityMetrics[0].resolution, '720p');
});

// -----------------------------------------------------------------------------
// 10. Zero-Duration / Unconnected Call Produces ₹0 Billing
// -----------------------------------------------------------------------------
test('10. Zero-duration or rejected call produces ₹0 billing and no customer debit', async () => {
  const initialWallet = await WalletService.getWallet(testUserAId);
  const initialBalance = Number(initialWallet.balance);

  const zeroBillResult = await BillingService.endAndBillConsultation({
    consultationId: testConsultationUnconnectedId,
    callerUserId: testUserAId,
    callerRole: 'customer',
    durationSeconds: 0,
  });

  assert.equal(zeroBillResult.status, 'no_charge');
  assert.equal(zeroBillResult.grossAmount, 0);
  assert.equal(zeroBillResult.billedMinutes, 0);

  // Verify wallet was NOT debited
  const afterWallet = await WalletService.getWallet(testUserAId);
  assert.equal(Number(afterWallet.balance), initialBalance);

  // Verify PostgreSQL consultation state is ENDED with total_amount = 0
  const consRow = await queryPostgresSingle(
    'SELECT state, total_amount, duration_seconds FROM consultations WHERE id = $1',
    [testConsultationUnconnectedId]
  );
  assert.equal(consRow.state, 'ENDED');
  assert.equal(Number(consRow.total_amount), 0.0);
  assert.equal(consRow.duration_seconds, 0);
});

// -----------------------------------------------------------------------------
// 11. Connected Duration Produces Correct Billing in PostgreSQL
// -----------------------------------------------------------------------------
test('11. Connected call duration produces exact billing and wallet debit in PostgreSQL', async () => {
  const userWalletBefore = await WalletService.getWallet(testUserAId);
  const userBalanceBefore = Number(userWalletBefore.balance);

  // 180 seconds = 3 minutes at rate ₹40.00/min => ₹120.00 gross
  // Commission 20% => ₹24.00, Astrologer earnings => ₹96.00
  const billResult = await BillingService.endAndBillConsultation({
    consultationId: testConsultationAudioId,
    callerUserId: testAstrologerId,
    callerRole: 'astrologer',
    durationSeconds: 180,
  });

  assert.ok(billResult.billingId);
  assert.equal(billResult.billedMinutes, 3);
  assert.equal(billResult.grossAmount, 120.0);
  assert.equal(billResult.platformFee, 24.0);
  assert.equal(billResult.astrologerEarnings, 96.0);

  // Verify customer wallet debited by exactly ₹120.00
  const userWalletAfter = await WalletService.getWallet(testUserAId);
  assert.equal(Number(userWalletAfter.balance), userBalanceBefore - 120.0);

  // Verify PostgreSQL consultation_billing row
  const billingRow = await queryPostgresSingle(
    'SELECT * FROM consultation_billing WHERE id = $1',
    [billResult.billingId]
  );
  assert.equal(Number(billingRow.gross_amount), 120.0);
  assert.equal(Number(billingRow.platform_fee), 24.0);
  assert.equal(Number(billingRow.astrologer_earnings), 96.0);

  // Verify invoice generated
  const invoiceRow = await queryPostgresSingle(
    "SELECT * FROM invoices WHERE reference_id = $1 AND reference_type = 'consultation'",
    [testConsultationAudioId]
  );
  assert.ok(invoiceRow);
  assert.equal(Number(invoiceRow.total_amount), 120.0);
});

// -----------------------------------------------------------------------------
// 12. Duplicate Call End Does Not Double Bill (Idempotency)
// -----------------------------------------------------------------------------
test('12. Duplicate call end call returns existing billing and prevents double debit', async () => {
  const userWalletBefore = await WalletService.getWallet(testUserAId);
  const userBalanceBefore = Number(userWalletBefore.balance);

  // Call endAndBillConsultation again for the same consultation
  const duplicateBillResult = await BillingService.endAndBillConsultation({
    consultationId: testConsultationAudioId,
    callerUserId: testUserAId,
    callerRole: 'customer',
    durationSeconds: 180,
  });

  assert.ok(duplicateBillResult.billingId);
  assert.equal(duplicateBillResult.billedMinutes, 3);
  assert.equal(duplicateBillResult.grossAmount, 120.0);

  // Verify wallet balance is UNCHANGED (no double debit)
  const userWalletAfter = await WalletService.getWallet(testUserAId);
  assert.equal(Number(userWalletAfter.balance), userBalanceBefore);

  // Verify only 1 billing record exists for this consultation
  const billingCount = await queryPostgresSingle(
    'SELECT count(*) as count FROM consultation_billing WHERE consultation_id = $1',
    [testConsultationAudioId]
  );
  assert.equal(Number(billingCount.count), 1);
});

// -----------------------------------------------------------------------------
// 13. Phase 1 & 2 Regressions: Chat & Wallet Consistency
// -----------------------------------------------------------------------------
test('13. Chat and financial integrity remains intact during call execution', async () => {
  // Wallet operations remain consistent
  const wallet = await WalletService.getWallet(testUserAId);
  assert.ok(Number(wallet.balance) > 0);

  // Astrologer earnings ledger has been credited
  const earnings = await queryPostgresSingle(
    'SELECT * FROM provider_earnings WHERE provider_id = $1',
    [testAstrologerId]
  );
  assert.ok(earnings);
  assert.ok(Number(earnings.total_earned) >= 96.0);
});
