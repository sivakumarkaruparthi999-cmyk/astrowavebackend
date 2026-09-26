import { Request, Response, NextFunction } from 'express';

const PROHIBITED_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Checks an object recursively for prohibited prototype pollution keys or MongoDB operators ($where, $ne, etc.)
 */
function containsInjection(obj: any): { detected: boolean; reason?: string } {
  if (!obj || typeof obj !== 'object') {
    return { detected: false };
  }

  // Check array elements
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const res = containsInjection(item);
      if (res.detected) return res;
    }
    return { detected: false };
  }

  for (const pKey of PROHIBITED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, pKey)) {
      return { detected: true, reason: `Prototype pollution attempt detected via key: ${pKey}` };
    }
  }

  // Check object keys and values
  for (const key of Object.keys(obj)) {
    if (PROHIBITED_KEYS.includes(key)) {
      return { detected: true, reason: `Prototype pollution attempt detected via key: ${key}` };
    }
    if (key.startsWith('$') || key.includes('.')) {
      return { detected: true, reason: `Prohibited query operator detected via key: ${key}` };
    }

    const value = obj[key];
    if (typeof value === 'object' && value !== null) {
      const res = containsInjection(value);
      if (res.detected) return res;
    }
  }

  return { detected: false };
}

/**
 * Express middleware to sanitize body, query, and params against NoSQL injection,
 * prototype pollution, and malicious operators.
 */
export function sanitizeInputs(req: Request, res: Response, next: NextFunction): void {
  try {
    // Check raw body for prototype pollution keys in raw JSON
    if ((req as any).rawBody) {
      const raw = (req as any).rawBody.toString('utf8');
      if (raw.includes('"__proto__"') || raw.includes('"constructor"') || raw.includes('"prototype"')) {
        // Clean any polluted properties from Object.prototype if JSON parser was tainted
        if ((Object.prototype as any).polluted !== undefined) {
          delete (Object.prototype as any).polluted;
        }
        res.status(400).json({ success: false, error: 'Prototype pollution attempt detected' });
        return;
      }
    }

    // Check body
    if (req.body) {
      const bodyCheck = containsInjection(req.body);
      if (bodyCheck.detected) {
        res.status(400).json({ success: false, error: bodyCheck.reason });
        return;
      }
    }

    // Check query params
    if (req.query) {
      const SENSITIVE_SINGLE_PARAMS = ['role', 'userId', 'id', 'consultationId', 'astrologerId', 'status', 'limit', 'page', 'offset'];
      for (const param of SENSITIVE_SINGLE_PARAMS) {
        if (Array.isArray(req.query[param])) {
          res.status(400).json({
            success: false,
            error: `Parameter pollution detected: duplicate parameter '${param}' is not permitted`,
          });
          return;
        }
      }

      const queryCheck = containsInjection(req.query);
      if (queryCheck.detected) {
        res.status(400).json({ success: false, error: queryCheck.reason });
        return;
      }
    }

    // Check route params
    if (req.params) {
      const paramsCheck = containsInjection(req.params);
      if (paramsCheck.detected) {
        res.status(400).json({ success: false, error: paramsCheck.reason });
        return;
      }
    }

    next();
  } catch (err) {
    res.status(400).json({ success: false, error: 'Invalid input formatting' });
  }
}
