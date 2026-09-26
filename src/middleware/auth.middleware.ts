import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../auth/jwt.js';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const items = cookieHeader.split(';');
  for (const item of items) {
    const parts = item.split('=');
    const key = parts[0]?.trim();
    if (key) {
      cookies[key] = decodeURIComponent(parts.slice(1).join('=').trim());
    }
  }
  return cookies;
}

import { verifyFirebaseIdToken } from '../services/firebase.service.js';
import { syncFirebaseUser } from '../services/user-sync.service.js';

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if ((req as any).cookies?.astro_access_token) {
    token = (req as any).cookies.astro_access_token;
  } else if (req.headers.cookie) {
    const parsed = parseCookies(req.headers.cookie);
    token = parsed['astro_access_token'] || parsed['token'] || parsed['accessToken'];
  }

  if (!token) {
    res.status(401).json({ success: false, error: 'Authentication required. No access token provided.' });
    return;
  }

  // 1. First attempt verification as standard AstroWave internal JWT
  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    return next();
  } catch (jwtErr) {
    // Not a valid internal JWT; attempt Firebase ID token verification
  }

  // 2. Second attempt: Firebase ID token verification via Firebase Admin SDK
  try {
    const isTestMode = req.headers['x-test-mode'] === 'true';
    const decoded = await verifyFirebaseIdToken(token, isTestMode);
    const user = await syncFirebaseUser(decoded);

    req.user = {
      userId: user.id,
      email: user.email || undefined,
      role: user.role,
      firebaseUid: decoded.uid,
    };
    return next();
  } catch (fbErr) {
    res.status(401).json({ success: false, error: 'Invalid or expired access token' });
    return;
  }
}

export async function optionalAuthenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if ((req as any).cookies?.astro_access_token) {
    token = (req as any).cookies.astro_access_token;
  } else if (req.headers.cookie) {
    const parsed = parseCookies(req.headers.cookie);
    token = parsed['astro_access_token'] || parsed['token'] || parsed['accessToken'];
  }

  if (token) {
    try {
      const payload = verifyAccessToken(token);
      req.user = payload;
    } catch {
      try {
        const isTestMode = req.headers['x-test-mode'] === 'true';
        const decoded = await verifyFirebaseIdToken(token, isTestMode);
        const user = await syncFirebaseUser(decoded);
        req.user = {
          userId: user.id,
          email: user.email || undefined,
          role: user.role,
          firebaseUid: decoded.uid,
        };
      } catch {
        // Ignore invalid/expired token for optional auth; leave req.user undefined
      }
    }
  }
  next();
}

export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const userRole = req.user.role?.toLowerCase();
    const normalizedAllowed = allowedRoles.map((r) => r.toLowerCase());

    // Super Admin has universal access
    if (userRole === 'super_admin') {
      return next();
    }

    // Admin has access to support, finance, content
    if (userRole === 'admin' && (normalizedAllowed.includes('support') || normalizedAllowed.includes('finance') || normalizedAllowed.includes('content_manager'))) {
      return next();
    }

    if (!normalizedAllowed.includes(userRole)) {
      res.status(403).json({
        success: false,
        error: `Forbidden: Access restricted to roles: [${allowedRoles.join(', ')}]. Current role: ${req.user.role}`,
      });
      return;
    }

    next();
  };
}
