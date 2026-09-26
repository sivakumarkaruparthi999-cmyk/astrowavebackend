import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';
import app from './app.js';
import { connectMongo, checkDatabaseHealth, pgPool } from './config/db.js';
import { closeRedis } from './config/redis.js';
import { initSocketServer } from './websocket/socket.server.js';
import { BillingService } from './services/billing.service.js';
import { setupProcessErrorHandlers } from './utils/error-monitor.js';
import { logger } from './utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const PORT = parseInt(process.env.PORT || '5001', 10);
let isShuttingDown = false;

async function bootstrap() {
  // Connect to MongoDB
  await connectMongo();

  // Ensure PostgreSQL schema migrations and admin account are initialized before accepting requests
  try {
    const { runMigrations } = await import('./migrations/migrate.js');
    await runMigrations(false);
  } catch (migErr) {
    logger.error('PostgreSQL migration check encountered an error:', migErr);
  }

  try {
    const { createOrUpdateAdmin } = await import('./scripts/create-admin.js');
    await createOrUpdateAdmin(false);
  } catch (adminErr) {
    logger.error('Admin setup check encountered an error:', adminErr);
  }

  // Create HTTP and WebSocket server
  const server = http.createServer(app);

  const corsOrigin =
    process.env.NODE_ENV === 'production' && process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : '*';

  const io = new SocketIOServer(server, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // Initialize Socket handlers
  initSocketServer(io);

  server.listen(PORT, '0.0.0.0', async () => {
    logger.info(`🚀 AstroWave Backend Server started on port ${PORT}`, {
      port: PORT,
      livenessUrl: `http://localhost:${PORT}/health`,
      readinessUrl: `http://localhost:${PORT}/ready`,
      environment: process.env.NODE_ENV || 'development',
    });

    const health = await checkDatabaseHealth();
    logger.info('Database initial connection status', {
      postgres: health.postgres ? 'connected' : 'disconnected',
      mongo: health.mongo ? 'connected' : 'fallback_or_disconnected',
    });
  });

  // Graceful shutdown handler (OPS-01)
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      logger.warn(`Shutdown already in progress, ignoring duplicate ${signal}`);
      return;
    }
    isShuttingDown = true;
    logger.info(`Graceful shutdown initiated (${signal})`);

    // Safety timeout: force exit if graceful teardown stalls
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out (10s), forcing process termination');
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    try {
      // 0. Stop billing scheduler
      BillingService.stopBillingScheduler();

      // 1. Stop Socket.IO from accepting new connections
      io.close(() => {
        logger.info('Socket.IO server closed');
      });

      // 2. Close HTTP server and allow in-flight requests to complete
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          logger.info('HTTP server closed');
          resolve();
        });
      });

      // 3. Close PostgreSQL pool
      await pgPool.end();
      logger.info('PostgreSQL connection pool closed');

      // 4. Disconnect MongoDB
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        logger.info('MongoDB disconnected');
      }

      // 5. Close Redis connection
      await closeRedis();

      logger.info('Graceful shutdown completed cleanly');
      process.exit(0);
    } catch (err) {
      logger.error('Error during graceful shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Initialize uncaught exception and unhandled rejection listeners with graceful shutdown
  setupProcessErrorHandlers(shutdown);
}

bootstrap().catch((err) => {
  logger.error('Failed to bootstrap AstroWave Backend', err);
  process.exit(1);
});
