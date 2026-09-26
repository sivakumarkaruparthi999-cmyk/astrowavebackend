import Razorpay from 'razorpay';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

function cleanEnvVar(val?: string): string {
  if (!val) return '';
  let str = val.trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

export const getRazorpayKeyId = (): string => {
  return cleanEnvVar(process.env.RAZORPAY_KEY_ID);
};

export const getRazorpayKeySecret = (): string => {
  return cleanEnvVar(process.env.RAZORPAY_KEY_SECRET);
};

export function getRazorpayClient(): Razorpay {
  const key_id = getRazorpayKeyId();
  const key_secret = getRazorpayKeySecret();
  return new Razorpay({
    key_id,
    key_secret,
  });
}

// Razorpay SDK Instance
export const razorpayClient = getRazorpayClient();

export const getRazorpayMode = (): string => {
  if (process.env.RAZORPAY_MODE) {
    return process.env.RAZORPAY_MODE.toLowerCase().trim();
  }
  const keyId = getRazorpayKeyId();
  if (keyId.startsWith('rzp_test_')) {
    return 'test';
  }
  return 'test';
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
