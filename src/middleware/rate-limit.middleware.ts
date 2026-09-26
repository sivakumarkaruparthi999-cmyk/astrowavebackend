import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Request, Response } from 'express';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis.js';

// Factory helper to get Redis store or fallback to default memory store
function getRateLimitStore(prefix: string) {
  const redis = getRedisClient();
  if (redis) {
    return new RedisStore({
      // @ts-ignore - ioredis call supports variable arguments
      sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)),
      prefix: `astrowave:rl:${prefix}:`,
    });
  }
  return undefined; // Default in-memory store
}

// Format standard 429 rate limit error response
function createRateLimitHandler(message: string) {
  return (req: Request, res: Response) => {
    const requestId = req.requestId || (req.headers['x-request-id'] as string);
    const retryAfter = res.getHeader('Retry-After');
    res.status(429).json({
      success: false,
      message,
      error: message,
      retryAfter: retryAfter ? Number(retryAfter) : undefined,
      requestId,
    });
  };
}

// Scoped key generator combining normalized IP with endpoint route
const routeKeyGenerator = (req: Request): string => {
  const normalizedIp = ipKeyGenerator(req.ip || '127.0.0.1');
  return `${normalizedIp}-${req.baseUrl || ''}${req.path || ''}`;
};

// Scoped key generator for auth endpoints (IP + route + account target)
const authRouteKeyGenerator = (req: Request): string => {
  const normalizedIp = ipKeyGenerator(req.ip || '127.0.0.1');
  const target =
    req.body && typeof req.body === 'object' && (req.body.email || req.body.phone)
      ? String(req.body.email || req.body.phone).trim().toLowerCase()
      : '';
  return `${normalizedIp}-${req.baseUrl || ''}${req.path || ''}${target ? `-${target}` : ''}`;
};

// Scoped key generator for password reset
const passwordResetKeyGenerator = (req: Request): string => {
  const normalizedIp = ipKeyGenerator(req.ip || '127.0.0.1');
  const email =
    req.body && typeof req.body === 'object' && req.body.email
      ? String(req.body.email).trim().toLowerCase()
      : '';
  return `${normalizedIp}-${req.baseUrl || ''}${req.path || ''}${email ? `-${email}` : ''}`;
};

// Scoped key generator for refresh tokens
const refreshKeyGenerator = (req: Request): string => {
  const normalizedIp = ipKeyGenerator(req.ip || '127.0.0.1');
  const token =
    req.body && typeof req.body === 'object' && req.body.refreshToken
      ? String(req.body.refreshToken).slice(-16)
      : '';
  return `${normalizedIp}-${req.baseUrl || ''}${req.path || ''}${token ? `-${token}` : ''}`;
};

/**
 * 1. Auth Rate Limiter (/login, /register, /google, /firebase)
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('auth'),
  keyGenerator: authRouteKeyGenerator,
  handler: createRateLimitHandler('Too many authentication attempts. Please try again after 15 minutes.'),
});

/**
 * 2. OTP Request Limiter (/otp/send, /request-otp)
 * Strict limit to prevent SMS gateway exhaustion and financial drain
 */
export const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // 5 requests per 10 minutes
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('otp-send'),
  keyGenerator: authRouteKeyGenerator,
  handler: createRateLimitHandler('Too many OTP requests. Please wait 10 minutes before requesting another code.'),
});

/**
 * 3. OTP Verification Limiter (/otp/verify)
 * Prevents brute-forcing 4-digit or 6-digit OTP codes
 */
export const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('otp-verify'),
  keyGenerator: authRouteKeyGenerator,
  handler: createRateLimitHandler('Too many invalid OTP attempts. Please wait before trying again.'),
});

/**
 * 4. Password Reset Limiter (/forgot-password, /reset-password)
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('pwd-reset'),
  keyGenerator: passwordResetKeyGenerator,
  handler: createRateLimitHandler('Too many password reset requests. Please try again after 15 minutes.'),
});

/**
 * 5. Admin Auth Limiter (/admin/login)
 * Extremely strict brute-force defense
 */
export const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('admin-auth'),
  keyGenerator: authRouteKeyGenerator,
  handler: createRateLimitHandler('Too many failed admin login attempts. Account temporarily throttled for 15 minutes.'),
});

/**
 * 6. Financial Operations Limiter (/wallet/*, /payments/*, /payouts/*)
 */
export const financialLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('financial'),
  keyGenerator: routeKeyGenerator,
  handler: createRateLimitHandler('Financial request limit exceeded. Please wait a moment before trying again.'),
});

/**
 * 7. Consultation Lifecycle Limiter (/consultations/start, /consultations/:id/end)
 */
export const consultationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('consultations'),
  keyGenerator: routeKeyGenerator,
  handler: createRateLimitHandler('Consultation action limit reached. Please wait a moment before retrying.'),
});

/**
 * 8. Chat Message Limiter (/chat/messages)
 */
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 messages per minute
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('chat'),
  keyGenerator: routeKeyGenerator,
  handler: createRateLimitHandler('Chat message rate limit exceeded. Please slow down.'),
});

/**
 * 9. Call Initiation Limiter (/calls/initiate, /video-calls/initiate)
 */
export const callsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('calls'),
  keyGenerator: routeKeyGenerator,
  handler: createRateLimitHandler('Call request rate limit reached. Please wait a moment before retrying.'),
});

/**
 * 10. Search & Expensive Query Limiter
 */
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('search'),
  keyGenerator: routeKeyGenerator,
  handler: createRateLimitHandler('Search request limit exceeded. Please wait a moment before trying again.'),
});

/**
 * 11. Public Directory & Metadata Limiter
 */
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('public'),
  keyGenerator: routeKeyGenerator,
  handler: createRateLimitHandler('Too many requests to public endpoints. Please slow down.'),
});

/**
 * 12. Refresh Token Limiter
 */
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('refresh'),
  keyGenerator: refreshKeyGenerator,
  handler: createRateLimitHandler('Too many refresh token requests. Please try again later.'),
});

/**
 * 13. Global Fallback Limiter (applies to all endpoints)
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  store: getRateLimitStore('global'),
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || '127.0.0.1'),
  handler: createRateLimitHandler('Too many requests from this IP. Please try again later.'),
});

