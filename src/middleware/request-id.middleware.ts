import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger, requestContext } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      startTimeNs?: bigint;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const existingId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  const requestId =
    typeof existingId === 'string' && existingId.trim().length > 0
      ? existingId.trim()
      : crypto.randomUUID();

  req.requestId = requestId;
  req.startTimeNs = process.hrtime.bigint();
  res.setHeader('x-request-id', requestId);

  // Set correlation context
  const context = {
    requestId,
    userId: (req as any).user?.userId,
  };

  requestContext.run(context, () => {
    res.on('finish', () => {
      const endTimeNs = process.hrtime.bigint();
      const durationMs = Number(endTimeNs - (req.startTimeNs || endTimeNs)) / 1_000_000;

      // Update user ID in context if auth middleware populated req.user
      const finalUserId = (req as any).user?.userId || context.userId;

      // Do not log health checks in production if they are 200, to prevent log flooding
      const isHealth = req.path === '/health' || req.path === '/ready' || req.path === '/api/health';
      if (isHealth && res.statusCode === 200 && process.env.NODE_ENV === 'production') {
        return;
      }

      const logPayload = {
        requestId,
        userId: finalUserId,
        route: req.baseUrl ? `${req.baseUrl}${req.path}` : req.originalUrl || req.url,
        method: req.method,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
      };

      if (res.statusCode >= 500) {
        logger.error(`HTTP ${req.method} ${logPayload.route} completed with error`, logPayload);
      } else if (res.statusCode >= 400) {
        logger.warn(`HTTP ${req.method} ${logPayload.route} client error`, logPayload);
      } else {
        logger.info(`HTTP ${req.method} ${logPayload.route}`, logPayload);
      }
    });

    next();
  });
}
