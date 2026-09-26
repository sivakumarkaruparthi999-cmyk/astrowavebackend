import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { logger, sanitizeLogData, maskPhone, maskEmail } from '../src/utils/logger.js';
import { validateEnv } from '../src/config/env.js';
import { WalletService } from '../src/services/wallet.service.js';
import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';
import app from '../src/app.js';

let server: http.Server;
let baseUrl: string;
let testUserId: string;

before(async () => {
  // Start ephemeral server for testing endpoints
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  // Create isolated test user for wallet concurrency testing
  const res = await queryPostgresSingle(`
    INSERT INTO users (email, phone, password_hash, role)
    VALUES ('readiness_test_${Date.now()}@test.com', '+91${Math.floor(1000000000 + Math.random() * 9000000000)}', 'hash', 'customer')
    RETURNING id;
  `);
  testUserId = res.id;
  await WalletService.getWallet(testUserId);
});

after(async () => {
  if (testUserId) {
    await queryPostgres('DELETE FROM wallet_transactions WHERE wallet_id = $1', [testUserId]);
    await queryPostgres('DELETE FROM wallets WHERE user_id = $1', [testUserId]);
    await queryPostgres('DELETE FROM users WHERE id = $1', [testUserId]);
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await (await import('../src/config/db.js')).pgPool.end();
  await (await import('../src/config/redis.js')).closeRedis();
  setTimeout(() => process.exit(0), 100).unref();
});

// =============================================================================
// 1. Structured Logging & PII Masking Tests
// =============================================================================
test('1. Structured Logging: Mask sensitive PII (phone, email, password, token)', () => {
  assert.equal(maskPhone('+919876543210'), '+91****210');
  assert.equal(maskEmail('javed.sayed@example.com'), 'j***d@example.com');

  const dirtyPayload = {
    password: 'super_secret_password',
    token: 'eyJhGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMjMifQ.abc',
    phone: '+919876543210',
    email: 'test@example.com',
    user: {
      password_hash: '$2a$12$e0MYzXy6',
      credit_card: '1234567890123456',
    },
  };

  const cleanPayload = sanitizeLogData(dirtyPayload);
  assert.equal(cleanPayload.password, '[REDACTED]');
  assert.equal(cleanPayload.token, '[REDACTED]');
  assert.equal(cleanPayload.phone, '+91****210');
  assert.equal(cleanPayload.email, 't***t@example.com');
  assert.equal(cleanPayload.user.password_hash, '[REDACTED]');
  assert.equal(cleanPayload.user.credit_card, '[REDACTED]');
});

// =============================================================================
// 2. Health & Readiness Probe Tests
// =============================================================================
test('2. Health Check: GET /health returns 200 with service metadata', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'astrowave-api');
  assert.ok(data.timestamp);
});

test('3a. Readiness Check (Development Fallback): GET /ready returns 200 with non-blocking mongo warning in dev', async () => {
  const res = await fetch(`${baseUrl}/ready`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ready');
  assert.equal(data.checks.postgres, 'up');
  assert.equal(data.checks.config, 'valid');
  assert.equal(data.mode, 'development_fallback');
  // Confirm NO secrets, passwords or URIs are leaked
  const str = JSON.stringify(data);
  assert.ok(!str.includes('password'));
  assert.ok(!str.includes('postgresql://'));
  assert.ok(!str.includes('mongodb://'));
});

test('3b. Readiness Check (Production Strict): When Mongo is down, /ready MUST return 503 fail-closed', async () => {
  const res = await fetch(`${baseUrl}/ready`, {
    headers: { 'x-enforce-production-readiness': 'true' }
  });
  // Since MongoDB is not running locally, production strict mode MUST return 503
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.status, 'not_ready');
  assert.equal(data.mode, 'production_strict');
  assert.equal(data.checks.mongo, 'down');
});

test('3b-1. Readiness Check (Production Strict): When Mongo is UP, /ready MUST return 200 OK', async () => {
  const mongoose = (await import('mongoose')).default;
  const originalReadyState = mongoose.connection.readyState;
  // Simulate Mongo connected state (readyState === 1)
  Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

  try {
    const res = await fetch(`${baseUrl}/ready`, {
      headers: { 'x-enforce-production-readiness': 'true' }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ready');
    assert.equal(data.mode, 'production_strict');
    assert.equal(data.checks.postgres, 'up');
    assert.equal(data.checks.mongo, 'up');
  } finally {
    Object.defineProperty(mongoose.connection, 'readyState', { value: originalReadyState, configurable: true });
  }
});

test('3c. Error Lifecycle: Process unhandledRejection handler initiates graceful shutdown', async () => {
  const { setupProcessErrorHandlers } = await import('../src/utils/error-monitor.js');
  let shutdownTriggered = false;
  let shutdownReason = '';

  const mockShutdown = async (reason: string) => {
    shutdownTriggered = true;
    shutdownReason = reason;
  };

  process.env.STRICT_UNHANDLED_CRASH = 'true';
  try {
    setupProcessErrorHandlers(mockShutdown, { exitProcess: false });

    const listeners = process.rawListeners('unhandledRejection');
    assert.ok(listeners.length > 0, 'Must have registered unhandledRejection listener');

    // Directly invoke the registered handler
    const lastHandler = listeners[listeners.length - 1] as Function;
    lastHandler(new Error('Simulated lifecycle rejection'));

    assert.equal(shutdownTriggered, true, 'unhandledRejection must trigger shutdown');
    assert.equal(shutdownReason, 'unhandledRejection', 'Reason must be unhandledRejection');
  } finally {
    delete process.env.STRICT_UNHANDLED_CRASH;
  }
});

// =============================================================================
// 3. Centralized Error Handling & Correlation ID Tests
// =============================================================================
test('4. Centralized Error Handling: 404 returns safe response with x-request-id', async () => {
  const res = await fetch(`${baseUrl}/api/non-existent-route-for-testing`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.success, false);
  assert.ok(data.message.includes('not found'));
  assert.ok(data.requestId);
  assert.equal(res.headers.get('x-request-id'), data.requestId);
});

test('5. Centralized Error Handling: Malformed JSON returns 400 with safe message', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broken": json}',
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.success, false);
  assert.equal(data.message, 'Malformed JSON payload in request body');
  assert.ok(data.requestId);
});

// =============================================================================
// 4. Rate Limiting Tests
// =============================================================================
test('6. Rate Limiting: Strict password reset limiter returns 429 after 5 requests', async () => {
  let hitRateLimit = false;
  let retryAfterHeader: string | null = null;

  for (let i = 0; i < 7; i++) {
    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rate_limit_target@example.com' }),
    });

    if (res.status === 429) {
      hitRateLimit = true;
      retryAfterHeader = res.headers.get('Retry-After');
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.message.includes('Too many password reset requests'));
      assert.ok(data.requestId);
      break;
    }
  }

  assert.ok(hitRateLimit, 'Password reset limiter should trigger 429');
});

// =============================================================================
// 5. Atomic Wallet Concurrency & Balance Integrity Tests
// =============================================================================
test('7. Wallet Concurrency: Concurrent credits maintain exact mathematical balance', async () => {
  // Reset balance
  await queryPostgres('UPDATE wallets SET balance = 0 WHERE user_id = $1', [testUserId]);

  // Execute 5 parallel credits of ₹100 with valid UUID reference IDs
  const promises = Array.from({ length: 5 }, (_, i) =>
    WalletService.creditWallet(
      testUserId,
      100,
      'test_topup',
      crypto.randomUUID(),
      `Credit test ${i}`
    )
  );

  await Promise.all(promises);

  const wallet = await WalletService.getWallet(testUserId);
  assert.equal(wallet.balance, 500);

  // Verify ledger transactions match balance exactly
  const txSum = await queryPostgresSingle(
    `SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions WHERE wallet_id = $1 AND type = 'credit'`,
    [testUserId]
  );
  assert.equal(Number(txSum.total), 500);
});

test('8. Wallet Concurrency: Concurrent debits prevent negative balance', async () => {
  // Current balance is 500. Attempt 6 simultaneous debits of ₹100 (total ₹600).
  // Exactly 5 must succeed and 1 must fail with insufficient balance.
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      WalletService.debitWallet(
        testUserId,
        100,
        'test_debit',
        crypto.randomUUID(),
        `Debit test ${i}`
      )
    )
  );

  const successes = results.filter((r) => r.status === 'fulfilled');
  const failures = results.filter((r) => r.status === 'rejected');

  assert.equal(successes.length, 5);
  assert.equal(failures.length, 1);

  const finalWallet = await WalletService.getWallet(testUserId);
  assert.equal(finalWallet.balance, 0, 'Balance must remain exactly 0 and never drop below 0');
});

// =============================================================================
// 6. Security & Role Boundaries Tests
// =============================================================================
test('9. Role Boundaries: Unauthenticated request to /api/admin/users rejected with 401', async () => {
  const res = await fetch(`${baseUrl}/api/admin/users`);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.success, false);
});
