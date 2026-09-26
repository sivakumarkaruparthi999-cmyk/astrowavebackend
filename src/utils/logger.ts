import { AsyncLocalStorage } from 'async_hooks';

export interface LogContext {
  requestId?: string;
  userId?: string;
}

export const requestContext = new AsyncLocalStorage<LogContext>();

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'token',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'idtoken',
  'id_token',
  'authorization',
  'secret',
  'key_secret',
  'webhook_secret',
  'webhooksecret',
  'private_key',
  'privatekey',
  'apikey',
  'api_key',
  'cvv',
  'cardnumber',
  'card_number',
  'credit_card',
  'creditcard',
  'card',
  'pan',
  'ssn',
  'pin',
  'otp',
  'secret_key',
  'keysecret',
]);

export function maskPhone(phone?: string | null): string {
  if (!phone || typeof phone !== 'string') return '';
  const clean = phone.trim();
  if (clean.length <= 4) return '***';
  return clean.slice(0, 3) + '****' + clean.slice(-3);
}

export function maskEmail(email?: string | null): string {
  if (!email || typeof email !== 'string') return '';
  const clean = email.trim();
  const parts = clean.split('@');
  if (parts.length !== 2) return '***@***';
  const name = parts[0];
  const domain = parts[1];
  const maskedName = name.length <= 2 ? name[0] + '***' : name[0] + '***' + name[name.length - 1];
  return `${maskedName}@${domain}`;
}

export function sanitizeLogData(obj: any, depth = 0): any {
  if (depth > 6) return '[Max Depth Exceeded]';
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Check if string looks like a JWT
    if (/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(obj)) {
      return '[REDACTED_JWT]';
    }
    // Check if string looks like Bearer token
    if (obj.startsWith('Bearer ')) {
      return 'Bearer [REDACTED_TOKEN]';
    }
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      stack: obj.stack,
    };
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeLogData(item, depth + 1));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (lowerKey === 'phone' || lowerKey === 'phonenumber' || lowerKey === 'phone_number') {
      sanitized[key] = typeof value === 'string' ? maskPhone(value) : '[REDACTED_PHONE]';
    } else if (lowerKey === 'email') {
      sanitized[key] = typeof value === 'string' ? maskEmail(value) : '[REDACTED_EMAIL]';
    } else {
      sanitized[key] = sanitizeLogData(value, depth + 1);
    }
  }

  return sanitized;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface StructuredLogPayload {
  timestamp: string;
  level: LogLevel;
  service: string;
  message?: string;
  requestId?: string;
  userId?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  error?: string;
  errorName?: string;
  stack?: string;
  [key: string]: any;
}

class StructuredLogger {
  private serviceName: string;

  constructor(serviceName = 'astrowave-api') {
    this.serviceName = serviceName;
  }

  private write(level: LogLevel, message: string, meta: Record<string, any> = {}) {
    const store = requestContext.getStore() || {};
    const timestamp = new Date().toISOString();

    const sanitizedMeta = sanitizeLogData(meta) || {};
    let errorStr: string | undefined;
    let errorNameStr: string | undefined;
    let stackStr: string | undefined;

    if (meta.error) {
      if (meta.error instanceof Error) {
        errorStr = meta.error.message;
        errorNameStr = meta.error.name;
        stackStr = meta.error.stack;
      } else if (typeof meta.error === 'string') {
        errorStr = meta.error;
      } else {
        errorStr = JSON.stringify(sanitizeLogData(meta.error));
      }
    }

    const payload: StructuredLogPayload = {
      timestamp,
      level,
      service: this.serviceName,
      message,
      requestId: sanitizedMeta.requestId || store.requestId,
      userId: sanitizedMeta.userId || store.userId,
      route: sanitizedMeta.route,
      method: sanitizedMeta.method,
      statusCode: sanitizedMeta.statusCode,
      durationMs: sanitizedMeta.durationMs,
      error: errorStr || sanitizedMeta.error,
      errorName: errorNameStr || sanitizedMeta.errorName,
      stack: stackStr || sanitizedMeta.stack,
      ...sanitizedMeta,
    };

    // Clean undefined fields
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) {
        delete payload[k];
      }
    });

    const jsonLine = JSON.stringify(payload);
    if (level === 'error') {
      process.stderr.write(jsonLine + '\n');
    } else {
      process.stdout.write(jsonLine + '\n');
    }
  }

  info(message: string, meta?: Record<string, any>) {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, any>) {
    this.write('warn', message, meta);
  }

  error(message: string, errorOrMeta?: any, extraMeta?: Record<string, any>) {
    let combinedMeta: Record<string, any> = {};
    if (errorOrMeta instanceof Error) {
      combinedMeta = { error: errorOrMeta, ...(extraMeta || {}) };
    } else if (typeof errorOrMeta === 'object') {
      combinedMeta = { ...errorOrMeta, ...(extraMeta || {}) };
    } else if (typeof errorOrMeta === 'string') {
      combinedMeta = { error: errorOrMeta, ...(extraMeta || {}) };
    } else {
      combinedMeta = extraMeta || {};
    }
    this.write('error', message, combinedMeta);
  }

  debug(message: string, meta?: Record<string, any>) {
    if (process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production') {
      this.write('debug', message, meta);
    }
  }
}

export const logger = new StructuredLogger(process.env.SERVICE_NAME || 'astrowave-api');
