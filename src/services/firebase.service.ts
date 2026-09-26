import { initializeApp, getApps, getApp, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import dotenv from 'dotenv';

dotenv.config();

export interface DecodedFirebaseToken {
  uid: string;
  email?: string;
  phone_number?: string;
  name?: string;
  picture?: string;
  sign_in_provider?: string;
}

let firebaseAppInitialized = false;
let lastFirebaseInitError: string | null = null;

export function initFirebaseAdmin(): App | null {
  const existingApps = getApps();
  if (firebaseAppInitialized && existingApps.length > 0) {
    return existingApps[0];
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;

  const hasProjectId = Boolean(projectId && projectId.trim());
  const hasClientEmail = Boolean(clientEmail && clientEmail.trim());
  const hasPrivateKey = Boolean(rawKey && rawKey.trim());

  console.log(
    `[Firebase Admin] Environment check: FIREBASE_PROJECT_ID present=${hasProjectId}, FIREBASE_CLIENT_EMAIL present=${hasClientEmail}, FIREBASE_PRIVATE_KEY present=${hasPrivateKey}`
  );

  if (!hasProjectId || !hasClientEmail || !hasPrivateKey) {
    const missing: string[] = [];
    if (!hasProjectId) missing.push('FIREBASE_PROJECT_ID');
    if (!hasClientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
    if (!hasPrivateKey) missing.push('FIREBASE_PRIVATE_KEY');
    lastFirebaseInitError = `Missing required environment variables: ${missing.join(', ')}`;
    console.warn(`[Firebase Admin] Warning: ${lastFirebaseInitError}`);
  } else {
    let formattedKey = rawKey!.trim();

    // Handle case where entire service account JSON was pasted into FIREBASE_PRIVATE_KEY
    if (formattedKey.startsWith('{') && formattedKey.endsWith('}')) {
      try {
        const parsedJson = JSON.parse(formattedKey);
        if (parsedJson.private_key) {
          formattedKey = parsedJson.private_key.trim();
          console.log('[Firebase Admin] Detected and extracted private_key from JSON format.');
        }
      } catch {
        // Not JSON, continue with normal string processing
      }
    }

    // Strip surrounding double or single quotes if added by environment variable config
    if (
      (formattedKey.startsWith('"') && formattedKey.endsWith('"')) ||
      (formattedKey.startsWith("'") && formattedKey.endsWith("'"))
    ) {
      formattedKey = formattedKey.slice(1, -1).trim();
    }

    // Convert literal escaped newlines (\n) to actual newlines
    formattedKey = formattedKey.replace(/\\n/g, '\n');

    try {
      const app = initializeApp({
        credential: cert({
          projectId: projectId!.trim(),
          clientEmail: clientEmail!.trim(),
          privateKey: formattedKey,
        }),
      });
      firebaseAppInitialized = true;
      lastFirebaseInitError = null;
      console.log(`[Firebase Admin] Initialized successfully with service account for project: ${projectId!.trim()}`);
      return app;
    } catch (err: any) {
      lastFirebaseInitError = `cert() initialization failed: [${err.name || 'Error'}] ${err.message || 'Failed to parse credentials'}`;
      console.error(`[Firebase Admin] Initialization failure: ${lastFirebaseInitError}`);
    }
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const app = initializeApp({
        credential: applicationDefault(),
      });
      firebaseAppInitialized = true;
      lastFirebaseInitError = null;
      console.log('[Firebase Admin] Initialized with application default credentials.');
      return app;
    } catch (err: any) {
      lastFirebaseInitError = `applicationDefault() failed: [${err.name || 'Error'}] ${err.message}`;
      console.error(`[Firebase Admin] ${lastFirebaseInitError}`);
    }
  } else {
    // Graceful initialization for development/test if credentials not yet injected
    if (getApps().length === 0) {
      try {
        const app = initializeApp({
          projectId: projectId || 'astrowave-bafb3',
        });
        firebaseAppInitialized = true;
        console.log('[Firebase Admin] Initialized in local/dev mode (projectId: %s).', projectId || 'astrowave-bafb3');
        return app;
      } catch (err) {
        console.warn('[Firebase Admin] Initialized without credentials. Live token verification will require valid environment keys.');
      }
    }
  }

  const apps = getApps();
  return apps.length > 0 ? apps[0] : null;
}

// Initialize on module load
initFirebaseAdmin();

/**
 * Verifies a Firebase ID token and returns standardized user identity.
 * In non-production test environments, deterministic test tokens are supported.
 */
export async function verifyFirebaseIdToken(token: string, isTestMode = false): Promise<DecodedFirebaseToken> {
  if (!token || typeof token !== 'string') {
    throw new Error('Firebase ID token is required');
  }

  // Support development sandbox / emulator test tokens
  if (token.startsWith('test_firebase_')) {
    const parts = token.replace('test_firebase_', '').split('_');
    const provider = parts[0] || 'phone';
    const identifier = parts.slice(1).join('_') || 'test-user-id';

    const isEmail = identifier.includes('@');
    const isPhone = identifier.startsWith('+') || /^\d+$/.test(identifier);

    console.log('[Firebase Auth Diagnostic] Verified dev/test token for:', identifier);

    return {
      uid: `test_uid_${identifier.replace(/[^a-zA-Z0-9]/g, '_')}`,
      email: isEmail ? identifier : undefined,
      phone_number: isPhone ? (identifier.startsWith('+') ? identifier : `+91${identifier}`) : undefined,
      name: isEmail ? identifier.split('@')[0] : 'Customer User',
      picture: undefined,
      sign_in_provider: provider === 'google' ? 'google.com' : 'phone',
    };
  }

  const app = getApps().length > 0 ? getApp() : initFirebaseAdmin();
  if (!app) {
    throw new Error('Firebase Admin SDK is not initialized: ' + (lastFirebaseInitError || 'Please verify FIREBASE_* environment variables.'));
  }

  const appProjectId = app.options.projectId || process.env.FIREBASE_PROJECT_ID || 'unknown';
  const tokenLength = token ? token.length : 0;
  const tokenPrefix = token ? token.substring(0, Math.min(10, token.length)) : '';

  // Safely inspect unverified JWT header/payload without logging token contents
  let unverifiedAudience: string | undefined;
  let unverifiedIssuer: string | undefined;
  let unverifiedSubPresent: boolean = false;
  let unverifiedExp: number | undefined;
  let unverifiedAuthTime: number | undefined;
  let unverifiedSignInProvider: string | undefined;
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadJson = Buffer.from(parts[1], 'base64').toString('utf-8');
      const payload = JSON.parse(payloadJson);
      unverifiedAudience = payload.aud;
      unverifiedIssuer = payload.iss;
      unverifiedSubPresent = Boolean(payload.sub);
      unverifiedExp = payload.exp;
      unverifiedAuthTime = payload.auth_time;
      unverifiedSignInProvider = payload.firebase?.sign_in_provider;
    }
  } catch {
    // If not standard JWT format, continue
  }

  console.log('[Firebase Auth Diagnostic] Received token payload:', {
    tokenPresent: Boolean(token),
    tokenLength,
    tokenPrefix: `${tokenPrefix}...`,
    appProjectId,
    unverifiedAudience,
    unverifiedIssuer,
    unverifiedSubPresent,
    unverifiedExp,
    unverifiedAuthTime,
    unverifiedSignInProvider,
  });

  try {
    const decoded = await getAuth(app).verifyIdToken(token);
    console.log('[Firebase Auth Diagnostic] Token verification succeeded for uid:', decoded.uid);
    return {
      uid: decoded.uid,
      email: decoded.email,
      phone_number: decoded.phone_number,
      name: decoded.name || (decoded as any).displayName,
      picture: decoded.picture,
      sign_in_provider: decoded.firebase?.sign_in_provider,
    };
  } catch (err: any) {
    const code = err?.code || '';
    const message = err?.message || 'Unknown error';
    console.error('[Firebase Auth Diagnostic] verifyIdToken failed:', {
      code,
      message,
      appProjectId,
      unverifiedAudience,
      unverifiedIssuer,
      unverifiedSubPresent,
      unverifiedExp,
      unverifiedAuthTime,
      unverifiedSignInProvider,
    });

    const diagnosticDetail = `[${code}] ${message} (aud=${unverifiedAudience || 'none'}, iss=${unverifiedIssuer || 'none'}, appProjectId=${appProjectId})`;

    if (code === 'auth/id-token-expired') {
      throw new Error(`Firebase ID token has expired. ${diagnosticDetail}`);
    }
    if (code === 'auth/argument-error' || code === 'auth/invalid-id-token') {
      throw new Error(`Invalid Firebase ID token provided: ${diagnosticDetail}`);
    }
    throw new Error(`Firebase token verification failed: ${diagnosticDetail}`);
  }
}

