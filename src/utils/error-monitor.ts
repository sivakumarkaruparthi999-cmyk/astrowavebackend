import * as Sentry from '@sentry/node';
import { logger, sanitizeLogData } from './logger.js';

let isSentryInitialized = false;

export function initErrorMonitoring(): void {
  const dsn = process.env.SENTRY_DSN;
  const environment = process.env.NODE_ENV || 'development';
  const release = process.env.APP_VERSION || '1.0.0';

  if (dsn && dsn.trim().length > 0) {
    try {
      Sentry.init({
        dsn,
        environment,
        release: `astrowave-api@${release}`,
        tracesSampleRate: environment === 'production' ? 0.2 : 1.0,
        beforeSend(event) {
          // Double safeguard: scrub any passwords, tokens, or auth headers before sending to Sentry
          if (event.request?.headers) {
            delete event.request.headers['authorization'];
            delete event.request.headers['cookie'];
          }
          if (event.request?.data) {
            event.request.data = sanitizeLogData(event.request.data);
          }
          return event;
        },
      });
      isSentryInitialized = true;
      logger.info('Sentry error monitoring initialized successfully', { environment, release });
    } catch (err) {
      logger.error('Failed to initialize Sentry error monitoring', err);
    }
  } else {
    logger.info('Error monitoring running in local structured logger mode (SENTRY_DSN not set)');
  }
}

export interface ErrorCaptureContext {
  requestId?: string;
  userId?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  tags?: Record<string, string>;
  extra?: Record<string, any>;
}

export function captureException(error: unknown, context?: ErrorCaptureContext): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const sanitizedContext = context ? sanitizeLogData(context) : {};

  // Server-side structured log
  logger.error(err.message, err, {
    requestId: sanitizedContext.requestId,
    userId: sanitizedContext.userId,
    route: sanitizedContext.route,
    method: sanitizedContext.method,
    statusCode: sanitizedContext.statusCode,
    tags: sanitizedContext.tags,
    extra: sanitizedContext.extra,
  });

  // Forward to Sentry if available
  if (isSentryInitialized) {
    try {
      Sentry.withScope((scope) => {
        if (sanitizedContext.requestId) {
          scope.setTag('requestId', sanitizedContext.requestId);
        }
        if (sanitizedContext.userId) {
          scope.setUser({ id: sanitizedContext.userId });
        }
        if (sanitizedContext.route) {
          scope.setTag('route', sanitizedContext.route);
        }
        if (sanitizedContext.method) {
          scope.setTag('method', sanitizedContext.method);
        }
        if (sanitizedContext.tags) {
          Object.entries(sanitizedContext.tags).forEach(([k, v]) => scope.setTag(k, String(v)));
        }
        if (sanitizedContext.extra) {
          scope.setExtras(sanitizedContext.extra);
        }
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      logger.error('Error forwarding exception to Sentry', sentryErr);
    }
  }
}

export function setupProcessErrorHandlers(
  shutdownFn?: (signal: string) => Promise<void>,
  options: { exitProcess?: boolean } = { exitProcess: true }
): void {
  process.on('uncaughtException', (err: Error) => {
    logger.error('FATAL: Uncaught Exception caught at process root', err, {
      fatal: true,
      errorName: err.name,
      message: err.message,
      stack: err.stack,
    });
    captureException(err, { tags: { fatal: 'true', type: 'uncaughtException' } });

    // In production, unhandled exceptions compromise process state; initiate graceful shutdown
    if (process.env.NODE_ENV === 'production' || process.env.STRICT_UNHANDLED_CRASH === 'true') {
      if (shutdownFn) {
        shutdownFn('uncaughtException').finally(() => {
          if (options.exitProcess !== false) {
            process.exit(1);
          }
        });
      } else if (options.exitProcess !== false) {
        setTimeout(() => process.exit(1), 1000).unref();
      }
    }
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('CRITICAL: Unhandled Promise Rejection caught at process root', err, {
      reason: String(reason),
      errorName: err.name,
      stack: err.stack,
    });
    captureException(err, { tags: { fatal: 'true', type: 'unhandledRejection' } });

    // For a financial application, continuing execution after an unhandled rejection is unsafe.
    // In production, initiate graceful shutdown and allow container orchestrator/PM2 to restart.
    if (process.env.NODE_ENV === 'production' || process.env.STRICT_UNHANDLED_CRASH === 'true') {
      logger.error('[Safety] Initiating graceful shutdown following unhandled rejection in financial application');
      if (shutdownFn) {
        shutdownFn('unhandledRejection').finally(() => {
          if (options.exitProcess !== false) {
            process.exit(1);
          }
        });
      } else if (options.exitProcess !== false) {
        setTimeout(() => process.exit(1), 1000).unref();
      }
    }
  });
}
