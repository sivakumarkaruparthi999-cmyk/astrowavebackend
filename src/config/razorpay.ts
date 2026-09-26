import Razorpay from 'razorpay';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const key_id = process.env.RAZORPAY_KEY_ID || '';
const key_secret = process.env.RAZORPAY_KEY_SECRET || '';

// Razorpay SDK Instance
export const razorpayClient = new Razorpay({
  key_id,
  key_secret,
});

export const getRazorpayKeyId = (): string => {
  return process.env.RAZORPAY_KEY_ID || '';
};

export const getRazorpayMode = (): string => {
  const mode = process.env.RAZORPAY_MODE;
  if (process.env.NODE_ENV === 'production') {
    if (mode === 'test') {
      throw new Error('FATAL: RAZORPAY_MODE cannot be set to "test" in production environment!');
    }
    return 'live';
  }
  return mode || 'test';
};

/**
 * Verify payment signature using HMAC SHA256 in constant time.
 * Payload format: order_id + "|" + payment_id
 */
export function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!secret || !params.signature || !params.orderId || !params.paymentId) {
    return false;
  }

  const payload = `${params.orderId}|${params.paymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(params.signature, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Verify webhook signature using raw request body in constant time.
 */
export function verifyWebhookSignature(params: {
  rawBody: Buffer | string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  if (!secret || !params.signature || !params.rawBody) {
    return false;
  }

  const payload = typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf8');
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(params.signature, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
