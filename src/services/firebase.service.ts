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

export function initFirebaseAdmin(): App | null {
  const existingApps = getApps();
  if (firebaseAppInitialized && existingApps.length > 0) {
    return existingApps[0];
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (privateKey) {
    // Replace escaped newlines if passed in single-line env var
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  if (projectId && clientEmail && privateKey) {
    try {
      const app = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      firebaseAppInitialized = true;
      console.log('[Firebase Admin] Initialized successfully with service account credentials.');
      return app;
    } catch (err) {
      console.error('[Firebase Admin] Failed to initialize with cert:', (err as Error).message);
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const app = initializeApp({
        credential: applicationDefault(),
      });
      firebaseAppInitialized = true;
      console.log('[Firebase Admin] Initialized with application default credentials.');
      return app;
    } catch (err) {
      console.error('[Firebase Admin] Failed to initialize with application default credentials:', (err as Error).message);
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

  // Automated test mock token support (strictly disallowed in production and development)
  if (
    process.env.NODE_ENV === 'test' &&
    token.startsWith('test_firebase_')
  ) {
    // Format: test_firebase_phone_+919876543210 or test_firebase_google_test@example.com or test_firebase_uid123
    const parts = token.replace('test_firebase_', '').split('_');
    const provider = parts[0] || 'phone';
    const identifier = parts.slice(1).join('_') || 'test-user-id';

    const isEmail = identifier.includes('@');
    const isPhone = identifier.startsWith('+') || /^\d+$/.test(identifier);

    return {
      uid: `test_uid_${identifier.replace(/[^a-zA-Z0-9]/g, '_')}`,
      email: isEmail ? identifier : undefined,
      phone_number: isPhone ? (identifier.startsWith('+') ? identifier : `+91${identifier}`) : undefined,
      name: isEmail ? identifier.split('@')[0] : 'Test Firebase User',
      picture: undefined,
      sign_in_provider: provider === 'google' ? 'google.com' : 'phone',
    };
  }

  const app = getApps().length > 0 ? getApp() : initFirebaseAdmin();
  if (!app) {
    throw new Error('Firebase Admin SDK is not initialized. Please verify FIREBASE_* environment variables.');
  }

  try {
    const decoded = await getAuth(app).verifyIdToken(token);
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
    if (code === 'auth/id-token-expired') {
      throw new Error('Firebase ID token has expired. Please refresh your session.');
    }
    if (code === 'auth/argument-error' || code === 'auth/invalid-id-token') {
      throw new Error('Invalid Firebase ID token provided.');
    }
    throw new Error(`Firebase token verification failed: ${err.message || 'Unknown error'}`);
  }
}
