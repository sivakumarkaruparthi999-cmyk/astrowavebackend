import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5001'),
  SERVICE_NAME: z.string().default('astrowave-api'),
  APP_VERSION: z.string().default('1.0.0'),

  // JWT Security
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),

  // PostgreSQL
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().optional(),
  PGPORT: z.string().optional(),
  PGDATABASE: z.string().optional(),
  PGUSER: z.string().optional(),
  PGPASSWORD: z.string().optional(),

  // MongoDB
  MONGODB_URI: z.string().optional(),

  // Redis
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().optional(),

  // Razorpay Payments
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Observability & Security
  SENTRY_DSN: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  STORAGE_PATH: z.string().optional(),
});

export type ValidatedEnv = z.infer<typeof envSchema>;

let cachedEnv: ValidatedEnv | null = null;

export function validateEnv(): ValidatedEnv {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errorDetails = result.error.format();
    const formatted = Object.entries(errorDetails)
      .filter(([k]) => k !== '_errors')
      .map(([k, v]) => `${k}: ${(v as any)?._errors?.join(', ')}`)
      .join('; ');

    const errorMsg = `Environment configuration validation failed: ${formatted}`;
    if (process.env.NODE_ENV === 'production') {
      console.error(`[FATAL] ${errorMsg}`);
      throw new Error(errorMsg);
    } else {
      console.warn(`[WARN] ${errorMsg}`);
    }
  }

  // Production-specific security checks
  if (process.env.NODE_ENV === 'production') {
    const jwtSecret = process.env.JWT_SECRET || '';
    if (jwtSecret.length < 32) {
      throw new Error('[FATAL] In production, JWT_SECRET must be at least 32 characters long.');
    }
    const jwtRefresh = process.env.JWT_REFRESH_SECRET || '';
    if (jwtRefresh.length < 32) {
      throw new Error('[FATAL] In production, JWT_REFRESH_SECRET must be at least 32 characters long.');
    }
    if (!process.env.DATABASE_URL && !process.env.PGHOST) {
      throw new Error('[FATAL] In production, PostgreSQL configuration (DATABASE_URL or PGHOST) is required.');
    }
  }

  cachedEnv = (result.success ? result.data : process.env) as ValidatedEnv;
  return cachedEnv;
}

export function getConfigSummary(): Record<string, boolean | string> {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '1.0.0',
    service: process.env.SERVICE_NAME || 'astrowave-api',
    postgresConfigured: Boolean(process.env.DATABASE_URL || process.env.PGHOST),
    mongoConfigured: Boolean(process.env.MONGODB_URI),
    redisConfigured: Boolean(process.env.REDIS_URL || process.env.REDIS_HOST),
    razorpayConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    sentryConfigured: Boolean(process.env.SENTRY_DSN),
    corsConfigured: Boolean(process.env.CORS_ORIGINS),
    productionMode: isProd,
  };
}
