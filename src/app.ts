import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';

import authRoutes from './routes/auth.routes.js';
import usersRoutes from './routes/users.routes.js';
import astrologersRoutes from './routes/astrologers.routes.js';
import consultationsRoutes from './routes/consultations.routes.js';
import chatRoutes from './routes/chat.routes.js';
import poojaRoutes from './routes/pooja.routes.js';
import muhuratRoutes from './routes/muhurat.routes.js';
import paymentsRoutes from './routes/payments.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import callsRoutes from './routes/calls.routes.js';
import videoCallsRoutes from './routes/video-calls.routes.js';
import payoutsRoutes from './routes/payouts.routes.js';
import astrologyRoutes from './routes/astrology.routes.js';
import adminRoutes from './routes/admin.routes.js';

import { checkDatabaseHealth, queryPostgres, queryPostgresSingle } from './config/db.js';
import { checkRedisHealth } from './config/redis.js';
import { validateEnv, getConfigSummary } from './config/env.js';
import { authenticate, AuthenticatedRequest } from './middleware/auth.middleware.js';
import { sanitizeInputs } from './middleware/sanitize.middleware.js';
import { requestIdMiddleware } from './middleware/request-id.middleware.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';
import { initErrorMonitoring } from './utils/error-monitor.js';
import { logger } from './utils/logger.js';
import {
  globalLimiter,
  authLimiter,
  adminAuthLimiter,
  financialLimiter,
  consultationLimiter,
  chatLimiter,
  callsLimiter,
  searchLimiter,
  publicLimiter,
} from './middleware/rate-limit.middleware.js';

dotenv.config();

// Validate critical environment variables on startup
validateEnv();

// Initialize Sentry error monitoring
initErrorMonitoring();

const app: Express = express();

// Express proxy security: strictly do not trust arbitrary client forwarding headers
app.set('trust proxy', false);

// 1. Structured Logging & Correlation ID Propagation Middleware
app.use(requestIdMiddleware);

// 2. Security Headers via Helmet
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'http:', 'https:'],
        connectSrc: ["'self'", 'http:', 'https:', 'ws:', 'wss:'],
        frameAncestors: ["'self'"],
      },
    },
    frameguard: { action: 'sameorigin' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

// Standard API response headers
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// Whitelisted origins for CORS
const configuredOrigins = (process.env.CORS_ORIGINS || process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const isProduction = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS: string[] = isProduction
  ? configuredOrigins
  : [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5001',
      'http://127.0.0.1:5001',
      'http://10.0.2.2:5001',
      'http://10.0.2.2:3000',
      ...configuredOrigins,
    ];

// CSRF Defense: Block unauthorized cross-origin state mutations when browser sends Origin
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  const method = req.method.toUpperCase();

  if (origin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({
        success: false,
        message: 'Forbidden: Cross-origin state mutation blocked by CSRF / Origin policy',
        error: 'Forbidden: Cross-origin state mutation blocked by CSRF / Origin policy',
        requestId: req.requestId,
      });
      return;
    }
  }
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser agents (mobile apps, backend services) without Origin header
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

// Optional morgan logger in local development
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Request body size limits (1MB standard limit prevents memory exhaustion)
app.use(
  express.json({
    limit: '1mb',
    verify: (req: any, _res: any, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Input sanitization against NoSQL injection, prototype pollution, and malicious operators
app.use(sanitizeInputs);

// Global Rate Limiter
app.use(globalLimiter);

// Static uploads serving (public subdirectories)
const uploadDir = process.env.STORAGE_PATH || process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
app.use('/uploads/avatars', express.static(path.join(uploadDir, 'avatars')));
app.use('/uploads/pooja', express.static(path.join(uploadDir, 'pooja')));
app.use('/uploads/chat', express.static(path.join(uploadDir, 'chat')));

// Protected documents serving (requires authentication, path traversal defense, and ownership/admin check)
app.get('/uploads/documents/:filename', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const callerId = req.user?.userId;
    const callerRole = req.user?.role;
    const rawFilename = req.params.filename;

    // Reject path traversal characters explicitly
    if (
      rawFilename.includes('..') ||
      rawFilename.includes('/') ||
      rawFilename.includes('\\') ||
      decodeURIComponent(rawFilename).includes('..') ||
      decodeURIComponent(rawFilename).includes('/') ||
      decodeURIComponent(rawFilename).includes('\\')
    ) {
      res.status(400).json({ success: false, message: 'Path traversal sequence detected', error: 'Path traversal sequence detected', requestId: req.requestId });
      return;
    }

    const filename = path.basename(rawFilename);
    const targetDir = path.resolve(uploadDir, 'documents');
    const resolvedPath = path.resolve(targetDir, filename);

    // Verify resolved path is strictly within the documents directory
    if (!resolvedPath.startsWith(targetDir)) {
      res.status(403).json({ success: false, message: 'Forbidden: Invalid file path', error: 'Forbidden: Invalid file path', requestId: req.requestId });
      return;
    }

    if (!fs.existsSync(resolvedPath)) {
      res.status(404).json({ success: false, message: 'Document not found', error: 'Document not found', requestId: req.requestId });
      return;
    }

    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';
    if (!isAdmin) {
      const doc = await queryPostgresSingle(
        'SELECT id FROM astrologer_documents WHERE astrologer_id = $1 AND document_url LIKE $2',
        [callerId, `%${filename}%`]
      );
      if (!doc) {
        res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to view this document', error: 'Forbidden: You do not have permission to view this document', requestId: req.requestId });
        return;
      }
    }

    res.sendFile(resolvedPath);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to access document', error: (err as Error).message, requestId: req.requestId });
  }
});

// Root endpoint for browser visits
app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: '🚀 AstroWave Backend API is running',
    version: process.env.APP_VERSION || '1.0.0',
    service: 'astrowave-api',
    endpoints: {
      liveness: '/health',
      readiness: '/ready',
      apiHealth: '/api/health',
      auth: '/api/auth',
      astrologers: '/api/astrologers',
      consultations: '/api/consultations',
      chat: '/api/chat',
      wallet: '/api/wallet',
    },
  });
});

/**
 * 4. HEALTH CHECKS & READINESS
 * ==================================================
 * GET /health - Liveness probe: verifies process is alive and responsive
 */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'astrowave-api',
    version: process.env.APP_VERSION || '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /ready - Readiness probe: verifies critical dependencies without exposing secrets
 */
app.get('/ready', async (req: Request, res: Response) => {
  // Production mode strictly enforces persistent storage (PostgreSQL AND MongoDB)
  // In development, real-time in-memory store is permitted as fallback
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.REQUIRE_MONGODB === 'true' ||
    req.headers['x-enforce-production-readiness'] === 'true';

  const dbHealth = await checkDatabaseHealth();
  const redisHealthy = await checkRedisHealth();

  // PostgreSQL is ALWAYS required for financial data and users
  const isPostgresReady = dbHealth.postgres;
  // MongoDB is mandatory in production for chat/call audit persistence; in development, inMemoryChatStore is permitted
  const isMongoReady = isProd ? dbHealth.mongo : true;

  const isReady = isPostgresReady && isMongoReady;
  const statusCode = isReady ? 200 : 503;

  // Retrieve public schema tables and migration metadata safely without sensitive data
  let tables: string[] = [];
  let migrations: string[] = [];
  let hasAdmin = false;
  let adminAccounts: Array<{ email: string; role: string; status: string; hasPassword: boolean; created_at: string; updated_at: string }> = [];
  if (isPostgresReady) {
    try {
      const tableRows = await queryPostgres<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      );
      tables = tableRows.map((r) => r.table_name);

      if (tables.includes('schema_migrations')) {
        const migRows = await queryPostgres<{ filename: string }>(
          `SELECT filename FROM schema_migrations ORDER BY id ASC`
        );
        migrations = migRows.map((r) => r.filename);
      }

      if (tables.includes('users')) {
        const adminUsers = await queryPostgres<{
          email: string;
          role: string;
          status: string;
          hasPassword: boolean;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT email, role, status, (password_hash IS NOT NULL AND password_hash != '') as "hasPassword", created_at, updated_at
           FROM users
           WHERE role IN ('admin', 'super_admin')
           ORDER BY created_at ASC`
        );
        adminAccounts = adminUsers;
        hasAdmin = adminAccounts.length > 0;
      }
    } catch {
      // Non-blocking metadata query
    }
  }

  const responsePayload = {
    status: isReady ? 'ready' : 'not_ready',
    service: 'astrowave-api',
    version: process.env.APP_VERSION || '1.0.0',
    mode: isProd ? 'production_strict' : 'development_fallback',
    checks: {
      postgres: dbHealth.postgres ? 'up' : 'down',
      mongo: dbHealth.mongo ? 'up' : 'down',
      redis: redisHealthy ? 'up' : 'not_configured_or_down',
      config: 'valid',
    },
    database: {
      tablesCount: tables.length,
      tables,
      migrationsCount: migrations.length,
      migrations,
      hasAdmin,
    },
    adminDiagnostics: {
      adminEmailConfigured: Boolean(process.env.ADMIN_EMAIL || process.env.INITIAL_ADMIN_EMAIL),
      configuredAdminEmail: process.env.ADMIN_EMAIL || process.env.INITIAL_ADMIN_EMAIL || null,
      adminPasswordConfigured: Boolean(process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD),
      adminAccounts,
    },
    firebase: {
      projectId: process.env.FIREBASE_PROJECT_ID || 'not_set',
      clientEmailDomain: process.env.FIREBASE_CLIENT_EMAIL ? process.env.FIREBASE_CLIENT_EMAIL.split('@')[1] : null,
      clientEmailPrefix: process.env.FIREBASE_CLIENT_EMAIL ? process.env.FIREBASE_CLIENT_EMAIL.split('@')[0] : null,
      privateKeyConfigured: Boolean(process.env.FIREBASE_PRIVATE_KEY),
    },
    timestamp: new Date().toISOString(),
  };

  res.status(statusCode).json(responsePayload);
});

// Backward-compatible health check endpoint
app.get('/api/health', async (_req: Request, res: Response) => {
  const isProd = process.env.NODE_ENV === 'production';
  const dbHealth = await checkDatabaseHealth();
  const isHealthy = dbHealth.postgres && (isProd ? dbHealth.mongo : true);

  if (isProd) {
    if (!isHealthy) {
      return res.status(503).json({
        status: 'degraded',
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  }

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    databases: dbHealth,
    service: 'astrowave-api',
  });
});

// 3. API Routes with Tiered Rate Limiting
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/astrologers', publicLimiter, astrologersRoutes);
app.use('/api/consultations', consultationLimiter, consultationsRoutes);
app.use('/api/chat', chatLimiter, chatRoutes);
app.use('/api/pooja', publicLimiter, poojaRoutes);
app.use('/api/muhurat', publicLimiter, muhuratRoutes);
app.use('/api/payments', financialLimiter, paymentsRoutes);
app.use('/api/wallet', financialLimiter, walletRoutes);
app.use('/api/calls', callsLimiter, callsRoutes);
app.use('/api/video-calls', callsLimiter, videoCallsRoutes);
app.use('/api/payouts', financialLimiter, payoutsRoutes);
app.use('/api/astrology', searchLimiter, astrologyRoutes);
app.use('/api/admin', adminAuthLimiter, adminRoutes);

// Centralized 404 Handler
app.use(notFoundHandler);

// Centralized Safe Error Handler
app.use(errorHandler);

export default app;
