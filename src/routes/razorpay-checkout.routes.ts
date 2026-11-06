import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import {
  razorpayClient,
  getRazorpayKeyId,
  getRazorpayKeySecret,
  validateRazorpayConfig,
} from '../config/razorpay.js';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { WalletService } from '../services/wallet.service.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

/**
 * POST /api/create-order
 * Create a Razorpay Order via the Orders API with server-side amount validation
 * (min ₹1, max ₹100,000) and bounded exponential backoff retries for transient failures.
 * Strictly requires authenticated user session.
 */
async function handleCreateOrder(req: AuthenticatedRequest, res: Response): Promise<void> {
  // 1. Integration-time fail-fast check: Validate credentials configuration
  const configCheck = validateRazorpayConfig();
  if (!configCheck.valid) {
    console.error(
      `[Razorpay Config] Missing required environment variable(s): ${configCheck.missing.join(', ')}`
    );
    res.status(500).json({ error: 'payment provider misconfigured' });
    return;
  }

  // 2. Authentication check: User must be authenticated to create a payment order
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required to create a payment order' });
    return;
  }

  const { amount, currency = 'INR', receipt, notes } = req.body || {};

  // 3. Validate currency (ISO 4217 3-letter code)
  if (currency && (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency))) {
    res.status(400).json({ error: 'Invalid currency code. Must be a 3-letter ISO 4217 code (e.g. INR, USD).' });
    return;
  }
  const upperCurrency = (currency || 'INR').toUpperCase();

  // 4. Validate and enforce amount limits: integer between 100 paise (₹1) and 10,000,000 paise (₹100,000)
  let finalAmountSubunits: number;
  const internalOrderId = notes?.order_id || req.body?.order_id;

  if (internalOrderId) {
    const existingOrder = await queryPostgresSingle<{ amount: number; currency: string }>(
      'SELECT amount, currency FROM payments WHERE id::text = $1 OR order_id = $1',
      [internalOrderId]
    ).catch(() => null);

    if (existingOrder && existingOrder.amount) {
      finalAmountSubunits = Math.round(Number(existingOrder.amount) * 100);
    } else {
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100 || amount > 10000000) {
        res.status(400).json({
          error: 'amount must be an integer between 100 paise (₹1) and 10000000 paise (₹100,000)',
        });
        return;
      }
      finalAmountSubunits = amount;
    }
  } else {
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100 || amount > 10000000) {
      res.status(400).json({
        error: 'amount must be an integer between 100 paise (₹1) and 10000000 paise (₹100,000)',
      });
      return;
    }
    finalAmountSubunits = amount;
  }

  // 5. Sanitize receipt (internal reference, max 40 characters)
  const defaultReceipt = `rcpt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  let sanitizedReceipt = (receipt ? String(receipt) : defaultReceipt).trim();
  if (sanitizedReceipt.length > 40) {
    sanitizedReceipt = sanitizedReceipt.substring(0, 40);
  }

  const orderNotes: Record<string, any> = {
    ...(notes && typeof notes === 'object' ? notes : {}),
    user_id: userId,
    order_id: internalOrderId || sanitizedReceipt,
  };

  // 6. Call Razorpay Orders API with bounded exponential backoff (max 2 retries on timeout/5xx)
  let rzpOrder: any = null;
  const maxRetries = 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      rzpOrder = await razorpayClient.orders.create({
        amount: finalAmountSubunits,
        currency: upperCurrency,
        receipt: sanitizedReceipt,
        notes: orderNotes,
      });
      break;
    } catch (err: any) {
      const statusCode = err?.statusCode || err?.status;

      // HTTP 401 Unauthorized: Invalid credentials -> Configuration error, NEVER retry
      if (statusCode === 401) {
        console.error('[Razorpay Config] 401 Unauthorized from Razorpay API. Verify RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
        res.status(500).json({ error: 'payment provider misconfigured' });
        return;
      }

      // HTTP 400 Bad Request: Input validation error from Razorpay -> Return 400, NEVER retry
      if (statusCode === 400) {
        const description = err?.error?.description || err?.message || 'Bad request to payment provider';
        res.status(400).json({ error: description });
        return;
      }

      // Check if network timeout or 5xx server error
      const isNetworkOr5xx =
        !statusCode ||
        statusCode >= 500 ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ESOCKETTIMEDOUT';

      if (isNetworkOr5xx && attempt < maxRetries) {
        attempt++;
        const backoffMs = Math.min(1000, 300 * Math.pow(2, attempt - 1));
        console.warn(`[Razorpay Order] Network/5xx error on attempt ${attempt}. Retrying in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      console.error('[Razorpay Order] Order creation failed after retries:', err?.error?.description || err?.message);
      res.status(503).json({ error: 'Payment gateway temporarily unavailable' });
      return;
    }
  }

  // 7. Response contract validation: ensure order ID is returned
  if (!rzpOrder || !rzpOrder.id) {
    console.error('[Razorpay Integration] Contract mismatch: Orders API response missing id');
    res.status(502).json({ error: 'Invalid response from payment provider' });
    return;
  }

  // 8. Persist order id against internal order in PostgreSQL tied strictly to authenticated user
  try {
    await queryPostgres(
      `INSERT INTO payments (
        user_id, order_id, amount, currency, status, gateway, description
      )
      VALUES ($1, $2, $3, $4, 'pending', 'razorpay', $5)
      ON CONFLICT (order_id) DO NOTHING`,
      [
        userId,
        rzpOrder.id,
        finalAmountSubunits / 100, // INR decimal
        upperCurrency,
        `Standard Checkout Order ${rzpOrder.id}`,
      ]
    );
  } catch (dbErr) {
    console.warn('[Payments DB] Notice: payment record persistence error:', dbErr);
  }

  // 9. Return standard response including rotatable key_id for frontend
  res.status(200).json({
    order_id: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    key_id: getRazorpayKeyId(),
  });
}

/**
 * POST /api/verify-payment
 * Verify the payment signature server-side using constant-time HMAC-SHA256
 * before marking the internal order paid. Fully idempotent and owner-enforced.
 */
async function handleVerifyPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  // 1. Integration-time fail-fast check: Validate secret configuration
  const keySecret = getRazorpayKeySecret();
  if (!keySecret) {
    console.error('[Razorpay Config] Missing required environment variable: RAZORPAY_KEY_SECRET');
    res.status(500).json({ error: 'payment provider misconfigured' });
    return;
  }

  // 2. Authentication check: User must be authenticated to verify payment
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required to verify payment' });
    return;
  }

  // 3. Validate required fields from browser
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    res.status(400).json({
      error: 'Missing required payment verification fields: razorpay_payment_id, razorpay_order_id, and razorpay_signature are required',
    });
    return;
  }

  // 4. Find existing payment and enforce user ownership (or admin privileges)
  const existingPayment = await queryPostgresSingle<{
    id: string;
    status: string;
    user_id: string;
    amount: number;
    payment_id: string;
  }>('SELECT id, status, user_id, amount, payment_id FROM payments WHERE order_id = $1', [
    razorpay_order_id,
  ]);

  if (!existingPayment) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }

  const isOwner = existingPayment.user_id === userId;
  const isAdmin = ['admin', 'super_admin'].includes(req.user?.role || '');
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: 'Forbidden: You do not own this order' });
    return;
  }

  // 5. Idempotent check: If already marked paid, return success without duplicate processing
  if (existingPayment.status === 'paid') {
    res.status(200).json({
      status: 'success',
      message: 'Payment already verified',
      order_id: razorpay_order_id,
      payment_id: existingPayment.payment_id || razorpay_payment_id,
    });
    return;
  }

  // 6. Compute expected HMAC-SHA256 signature: order_id + "|" + payment_id
  const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(payload)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(String(razorpay_signature), 'utf8');

  // Constant-time comparison
  const signatureMatches =
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer);

  if (!signatureMatches) {
    console.warn(`[Razorpay Signature] Signature verification failed for order ${razorpay_order_id}`);
    res.status(400).json({ error: 'Invalid payment signature' });
    return;
  }

  // 7. SIGNATURE IS VERIFIED: Mark internal payment record paid atomically
  try {
    await queryPostgres(
      `UPDATE payments
       SET payment_id = $1, signature = $2, status = 'paid', gateway_status = 'captured', updated_at = NOW()
       WHERE order_id = $3 AND status != 'paid'`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    );

    // Settle wallet credit to owner
    if (existingPayment.user_id) {
      await WalletService.creditWallet(
        existingPayment.user_id,
        Number(existingPayment.amount),
        'wallet_recharge',
        existingPayment.id,
        `Wallet recharge via Razorpay Checkout (${razorpay_payment_id})`
      ).catch((creditErr) => console.error('[WalletCredit] Warning:', creditErr));
    }
  } catch (dbErr) {
    console.error('[Payments DB] Error updating paid status:', dbErr);
  }

  res.status(200).json({
    status: 'success',
    message: 'Payment verified successfully',
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id,
  });
}

/**
 * GET /api/order-status/:order_id
 * Fallback to query payment status. Strictly requires authentication,
 * enforces ownership check, and returns a sanitized response stripped of customer PII.
 */
async function handleOrderStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { order_id } = req.params;
  if (!order_id) {
    res.status(400).json({ error: 'order_id parameter is required' });
    return;
  }

  try {
    const existingPayment = await queryPostgresSingle<{
      order_id: string;
      status: string;
      amount: number;
      currency: string;
      user_id: string;
    }>('SELECT order_id, status, amount, currency, user_id FROM payments WHERE order_id = $1', [
      order_id,
    ]);

    if (!existingPayment) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const isOwner = existingPayment.user_id === userId;
    const isAdmin = ['admin', 'super_admin'].includes(req.user?.role || '');
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Access denied: You do not have permission to view this order' });
      return;
    }

    // Sanitized response: only return public order state, never customer PII or raw Razorpay dumps
    res.status(200).json({
      order_id: existingPayment.order_id,
      status: existingPayment.status,
      amount: existingPayment.amount,
      currency: existingPayment.currency,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch order status' });
  }
}

// Support both /api-prefixed and root-relative paths for flexible mounting
// All endpoints are strictly authenticated
router.post('/create-order', authenticate, handleCreateOrder);
router.post('/api/create-order', authenticate, handleCreateOrder);

router.post('/verify-payment', authenticate, handleVerifyPayment);
router.post('/api/verify-payment', authenticate, handleVerifyPayment);

router.get('/order-status/:order_id', authenticate, handleOrderStatus);
router.get('/api/order-status/:order_id', authenticate, handleOrderStatus);

export default router;

