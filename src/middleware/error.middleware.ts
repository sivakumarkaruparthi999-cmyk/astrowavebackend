import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { captureException } from '../utils/error-monitor.js';

export interface AppError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
  type?: string;
  details?: any;
}

export function notFoundHandler(req: Request, res: Response): void {
  const requestId = req.requestId || (req.headers['x-request-id'] as string);
  const message = `Route ${req.method} ${req.originalUrl} not found`;
  res.status(404).json({
    success: false,
    message,
    error: message,
    requestId,
  });
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId || (req.headers['x-request-id'] as string);
  const isProd = process.env.NODE_ENV === 'production';

  // 1. Payload Too Large (413)
  if (err.type === 'entity.too.large' || err.status === 413) {
    res.status(413).json({
      success: false,
      message: 'Request payload too large (max 1MB)',
      error: 'Request payload too large (max 1MB)',
      requestId,
    });
    return;
  }

  // 2. Malformed JSON Body (400)
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    res.status(400).json({
      success: false,
      message: 'Malformed JSON payload in request body',
      error: 'Malformed JSON payload in request body',
      requestId,
    });
    return;
  }

  // 3. Zod Validation Error (400)
  if (err instanceof ZodError) {
    const formattedErrors = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    res.status(400).json({
      success: false,
      message: 'Input validation failed',
      error: formattedErrors[0]?.message || 'Input validation failed',
      errors: formattedErrors,
      requestId,
    });
    return;
  }

  // 4. Multer File Upload Errors (400)
  if (
    err.message &&
    (err.message.includes('Prohibited') ||
      err.message.includes('file extension') ||
      err.message.includes('MIME type') ||
      err.message.includes('File too large') ||
      err.code === 'LIMIT_FILE_SIZE')
  ) {
    res.status(400).json({
      success: false,
      message: err.message || 'File upload error',
      error: err.message || 'File upload error',
      requestId,
    });
    return;
  }

  // 5. Determine HTTP Status Code
  const statusCode =
    typeof err.status === 'number' && err.status >= 400 && err.status < 600
      ? err.status
      : typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  // 6. Capture server-side error with full stack trace & correlation context
  captureException(err, {
    requestId,
    userId: (req as any).user?.userId,
    route: req.originalUrl,
    method: req.method,
    statusCode,
    extra: {
      headers: {
        host: req.headers.host,
        'user-agent': req.headers['user-agent'],
      },
    },
  });

  // 7. Sanitize client message (strictly conceal DB queries, stack traces, file paths)
  let clientMessage = 'An unexpected error occurred. Please try again later.';

  if (statusCode < 500) {
    // 4xx errors are client errors, usually safe if they don't contain DB strings
    const rawMsg = err.message || 'Client error';
    const isSensitive =
      /SELECT|INSERT|UPDATE|DELETE|relation|column|database|syntax error|pg_|mongodb|sql/i.test(rawMsg);
    clientMessage = isSensitive ? 'Invalid request data' : rawMsg;
  } else {
    // 500 server errors
    if (!isProd) {
      // In development/test, keep details for debugging, but still strip passwords/tokens
      clientMessage = err.message || 'Internal server error';
    } else {
      clientMessage = 'Internal server error';
    }
  }

  res.status(statusCode).json({
    success: false,
    message: clientMessage,
    error: clientMessage,
    requestId,
  });
}
