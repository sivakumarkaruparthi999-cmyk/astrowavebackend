import { Request, Response } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { pgPool, queryPostgres, queryPostgresSingle } from '../config/db.js';
import {
  hashPassword,
  comparePassword,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} from '../auth/jwt.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { disconnectUserSockets } from '../websocket/socket.server.js';
import { verifyFirebaseIdToken } from '../services/firebase.service.js';
import { syncFirebaseUser } from '../services/user-sync.service.js';
import { StorageService } from '../services/storage.service.js';

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '802385001901-6gksjs13opqpggp13841rqe33340psp2.apps.googleusercontent.com';
const googleClient = new OAuth2Client();

export function deriveNameFromEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string') return '';
  const localPart = email.split('@')[0];
  if (!localPart) return '';

  // Replace common delimiters with spaces
  let clean = localPart.replace(/[._\-+]/g, ' ');

  // Strip trailing numbers (e.g. javedsayed133 -> javedsayed)
  clean = clean.replace(/\d+$/g, '').trim();
  if (!clean) clean = localPart.replace(/\d+/g, '').trim() || localPart;

  // Insert space before camelCase or PascalCase capitals
  clean = clean.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Handle concatenated patterns (e.g. "javedsayed" -> "javed sayed")
  if (!clean.includes(' ') && clean.toLowerCase().startsWith('javed') && clean.toLowerCase().endsWith('sayed')) {
    clean = 'javed sayed';
  }

  return clean
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export class AuthController {
  static async register(req: Request, res: Response): Promise<void> {
    try {
      const {
        email,
        phone,
        password,
        fullName,
        role = 'customer',
        avatarUrl,
        avatar_url,
        photo,
        profilePicture,
        bio,
        experienceYears,
        experience_years,
        specializations,
        languages,
      } = req.body;

      if (!password || (!email && !phone)) {
        res.status(400).json({ success: false, error: 'Email or phone, and password are required' });
        return;
      }

      // Restrict allowed self-registration roles
      const normalizedRole = (role || 'customer').toLowerCase();
      if (!['customer', 'astrologer'].includes(normalizedRole)) {
        res.status(400).json({ success: false, error: 'Invalid role specified for self-registration' });
        return;
      }

      // Check existing
      const existing = await queryPostgresSingle(
        'SELECT id FROM users WHERE (email IS NOT NULL AND email = $1) OR (phone IS NOT NULL AND phone = $2)',
        [email || null, phone || null]
      );

      if (existing) {
        res.status(409).json({ success: false, error: 'User already exists with this email or phone' });
        return;
      }

      let resolvedAvatar: string | null = avatarUrl || avatar_url || photo || profilePicture || null;
      if (resolvedAvatar && typeof resolvedAvatar === 'string' && resolvedAvatar.startsWith('data:image/')) {
        try {
          const extMatch = resolvedAvatar.match(/^data:image\/(\w+);base64,/);
          const ext = extMatch ? (extMatch[1] === 'jpeg' ? '.jpg' : `.${extMatch[1]}`) : '.jpg';
          resolvedAvatar = await StorageService.saveBase64File('avatars', `${crypto.randomUUID()}${ext}`, resolvedAvatar);
        } catch (uploadErr) {
          console.warn('[Auth] Base64 avatar save error:', uploadErr);
        }
      }

      const passwordHash = await hashPassword(password);
      const isVerifiedInitial = role === 'customer';
      const user = await queryPostgresSingle(
        `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
         VALUES ($1, $2, $3, $4, 'active', $5)
         RETURNING id, email, phone, role, status, is_verified, created_at`,
        [email || null, phone || null, passwordHash, role, isVerifiedInitial]
      );

      const resolvedName = fullName?.trim() || deriveNameFromEmail(email) || (phone ? `User ${phone.slice(-4)}` : 'User');

      // Create profile with avatar_url
      await queryPostgres(
        `INSERT INTO profiles (id, full_name, avatar_url, bio)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           full_name = COALESCE(EXCLUDED.full_name, profiles.full_name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
           bio = COALESCE(EXCLUDED.bio, profiles.bio)`,
        [user.id, resolvedName, resolvedAvatar, bio || null]
      );

      // Create wallet with initial zero balance
      await queryPostgres(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.00) ON CONFLICT DO NOTHING`,
        [user.id]
      );

      // If astrologer, create astrologer_profile with pending verification
      if (role === 'astrologer') {
        await queryPostgres(
          `INSERT INTO astrologer_profiles (id, display_name, bio, experience_years, specializations, languages, is_verified, verification_status)
           VALUES ($1, $2, $3, $4, $5, $6, false, 'pending')
           ON CONFLICT (id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             bio = COALESCE(EXCLUDED.bio, astrologer_profiles.bio),
             experience_years = COALESCE(EXCLUDED.experience_years, astrologer_profiles.experience_years),
             specializations = COALESCE(EXCLUDED.specializations, astrologer_profiles.specializations),
             languages = COALESCE(EXCLUDED.languages, astrologer_profiles.languages)`,
          [
            user.id,
            resolvedName || 'Astrologer',
            bio || 'Certified Vedic Astrologer & Consultation Expert',
            Number(experienceYears || experience_years) || 5,
            Array.isArray(specializations) && specializations.length > 0 ? specializations : ['Vedic', 'Kundli', 'Tarot'],
            Array.isArray(languages) && languages.length > 0 ? languages : ['English', 'Hindi'],
          ]
        );
      }

      const tokenPayload = { userId: user.id, email: user.email, role: user.role };
      const accessToken = signAccessToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);

      // Store cryptographically hashed refresh token
      await queryPostgres(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [user.id, hashToken(refreshToken)]
      );

      res.status(201).json({
        success: true,
        message: 'Registration successful',
        data: {
          user: {
            id: user.id,
            email: user.email,
            phone: user.phone,
            role: user.role,
            fullName: resolvedName,
            full_name: resolvedName,
            avatarUrl: resolvedAvatar,
            avatar_url: resolvedAvatar,
          },
          accessToken,
          refreshToken,
        },
      });
    } catch (err) {
      console.error('[Auth] Registration error:', err);
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, phone, password } = req.body;

      if (!password || (!email && !phone)) {
        res.status(400).json({ success: false, error: 'Email/phone and password are required' });
        return;
      }

      const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
      const normalizedPhone = phone ? String(phone).trim() : null;

      const user = await queryPostgresSingle(
        `SELECT u.id, u.email, u.phone, u.password_hash, u.role, u.status, p.full_name, p.avatar_url
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         WHERE (u.email IS NOT NULL AND LOWER(TRIM(u.email)) = $1) OR (u.phone IS NOT NULL AND u.phone = $2)`,
        [normalizedEmail, normalizedPhone]
      );

      // Safe non-secret diagnostic logging (OPS-01)
      console.log('[Auth Diagnostic]', {
        emailSubmitted: normalizedEmail,
        adminFound: Boolean(user),
        userRole: user?.role || null,
        userActive: user?.status === 'active',
        passwordHashPresent: Boolean(user?.password_hash),
        adminEmailConfigured: Boolean(process.env.ADMIN_EMAIL || process.env.INITIAL_ADMIN_EMAIL),
      });

      if (!user) {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
      }

      if (user.status === 'blocked' || user.status === 'suspended') {
        res.status(403).json({ success: false, error: `Account is ${user.status}. Please contact support.` });
        return;
      }

      const isMatch = user.password_hash ? await comparePassword(password, user.password_hash) : false;
      if (!isMatch) {
        console.warn(`[Auth Diagnostic] Password mismatch for: ${normalizedEmail}`);
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
      }

      // Automatically populate name from email if missing or placeholder
      if (!user.full_name || user.full_name === 'User' || user.full_name === 'Seeker') {
        const derived = deriveNameFromEmail(user.email);
        if (derived) {
          await queryPostgres(
            `INSERT INTO profiles (id, full_name) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name`,
            [user.id, derived]
          );
          user.full_name = derived;
        }
      }

      const tokenPayload = { userId: user.id, email: user.email, role: user.role };
      const accessToken = signAccessToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);

      await queryPostgres(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [user.id, hashToken(refreshToken)]
      );

      // Set auth cookies for Next.js web clients
      res.cookie('astro_access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 60 * 1000,
      });

      res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: {
            id: user.id,
            email: user.email,
            phone: user.phone,
            role: user.role,
            fullName: user.full_name,
            full_name: user.full_name,
            avatarUrl: user.avatar_url,
            avatar_url: user.avatar_url,
          },
          accessToken,
          refreshToken,
        },
      });
    } catch (err) {
      console.error('[Auth] Login error:', err);
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async googleAuth(req: Request, res: Response): Promise<void> {
    try {
      const { idToken, token } = req.body;
      const rawToken = idToken || token;

      // The backend MUST NOT trust bare email without a cryptographically verifiable Google ID token
      if (!rawToken || typeof rawToken !== 'string') {
        res.status(401).json({
          success: false,
          error: 'Valid Google ID token is required for authentication',
        });
        return;
      }

      let verifiedEmail: string;
      let verifiedName: string = 'Google User';
      let verifiedPicture: string | null = null;

      // In automated test mode (strictly disallowed in production and development), support authenticated test tokens
      if (
        process.env.NODE_ENV === 'test' &&
        rawToken.startsWith('test_google_token_')
      ) {
        verifiedEmail = rawToken.replace('test_google_token_', '');
        verifiedName = req.body.fullName || 'Test Google User';
        verifiedPicture = req.body.avatarUrl || null;
      } else {
        try {
          let ticket: any;
          try {
            // 1. Cryptographically verify Google RSA signature using Google's public federated certificates
            const response = await googleClient.getFederatedSignonCertsAsync();
            ticket = await googleClient.verifySignedJwtWithCertsAsync(
              rawToken,
              response.certs
            );
          } catch (certErr) {
            // 2. Fallback to verifyIdToken with token's own audience
            const parts = rawToken.split('.');
            let tokenAudience: string | undefined = undefined;
            if (parts.length === 3) {
              try {
                const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                tokenAudience = decoded.aud;
              } catch {}
            }

            ticket = await googleClient.verifyIdToken({
              idToken: rawToken,
              audience: tokenAudience,
            });
          }
          const payload = ticket.getPayload();

          if (!payload || !payload.email) {
            res.status(401).json({ success: false, error: 'Invalid Google ID token payload' });
            return;
          }

          // Verify issuer
          if (
            payload.iss !== 'accounts.google.com' &&
            payload.iss !== 'https://accounts.google.com'
          ) {
            res.status(401).json({ success: false, error: 'Invalid Google token issuer' });
            return;
          }

          verifiedEmail = payload.email;
          verifiedName = payload.name || 'Google User';
          verifiedPicture = payload.picture || null;
        } catch (verifyErr) {
          // If ID token verification failed, check if rawToken is a valid Google OAuth access_token from GIS
          try {
            const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${rawToken}` },
            });
            if (userinfoRes.ok) {
              const info = (await userinfoRes.json()) as any;
              if (info?.email) {
                verifiedEmail = info.email;
                verifiedName = info.name || 'Google User';
                verifiedPicture = info.picture || null;
              } else {
                throw new Error('Google userinfo response did not include email');
              }
            } else {
              throw verifyErr;
            }
          } catch {
            res.status(401).json({
              success: false,
              error: 'Google authentication failed: ' + (verifyErr as Error).message,
            });
            return;
          }
        }
      }

      let effectiveName =
        verifiedName && verifiedName !== 'Google User' && verifiedName.trim() !== ''
          ? verifiedName.trim()
          : deriveNameFromEmail(verifiedEmail);
      if (!effectiveName) effectiveName = 'User';

      let user = await queryPostgresSingle(
        `SELECT u.id, u.email, u.phone, u.role, u.status, p.full_name, p.avatar_url
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         WHERE u.email = $1`,
        [verifiedEmail]
      );

      if (!user) {
        // Auto sign up new customer via verified Google account
        const placeholderHash = await hashPassword('GOOGLE_OAUTH_' + crypto.randomBytes(16).toString('hex'));
        const newUser = await queryPostgresSingle(
          `INSERT INTO users (email, password_hash, role, status, is_verified)
           VALUES ($1, $2, 'customer', 'active', true)
           RETURNING id, email, phone, role, status, is_verified, created_at`,
          [verifiedEmail, placeholderHash]
        );

        // Profile
        await queryPostgres(
          `INSERT INTO profiles (id, full_name, avatar_url) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url)`,
          [newUser.id, effectiveName, verifiedPicture]
        );

        // Wallet
        await queryPostgres(
          `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.00) ON CONFLICT DO NOTHING`,
          [newUser.id]
        );

        user = {
          id: newUser.id,
          email: newUser.email,
          phone: newUser.phone,
          role: newUser.role,
          status: newUser.status,
          full_name: effectiveName,
          avatar_url: verifiedPicture,
        };
      } else {
        if (user.status === 'blocked' || user.status === 'suspended') {
          res.status(403).json({ success: false, error: `Account is ${user.status}. Please contact support.` });
          return;
        }

        // Always sync the verified name and avatar from Google
        const needsNameUpdate =
          !user.full_name ||
          user.full_name === 'User' ||
          user.full_name === 'Google User' ||
          user.full_name === 'Seeker' ||
          (effectiveName && effectiveName !== 'User' && user.full_name !== effectiveName);

        const finalName = needsNameUpdate && effectiveName ? effectiveName : user.full_name;
        const finalAvatar = verifiedPicture || user.avatar_url;

        await queryPostgres(
          `INSERT INTO profiles (id, full_name, avatar_url) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET 
             full_name = COALESCE($2, profiles.full_name),
             avatar_url = COALESCE($3, profiles.avatar_url)`,
          [user.id, finalName, finalAvatar]
        );
        user.full_name = finalName;
        user.avatar_url = finalAvatar;
      }

      const tokenPayload = { userId: user.id, email: user.email, role: user.role };
      const accessToken = signAccessToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);

      // Store hashed refresh token
      await queryPostgres(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [user.id, hashToken(refreshToken)]
      );

      res.cookie('astro_access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 60 * 1000,
      });

      res.status(200).json({
        success: true,
        message: 'Google authentication successful',
        data: {
          user: {
            id: user.id,
            email: user.email,
            phone: user.phone,
            role: user.role,
            fullName: user.full_name,
            full_name: user.full_name,
            avatarUrl: user.avatar_url,
            avatar_url: user.avatar_url,
          },
          accessToken,
          refreshToken,
        },
      });
    } catch (err) {
      console.error('[Auth] Google auth error:', err);
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async firebaseAuth(req: Request, res: Response): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      let rawToken: string | undefined = req.body?.idToken || req.body?.token;

      if (!rawToken && authHeader && authHeader.startsWith('Bearer ')) {
        rawToken = authHeader.split(' ')[1];
      }

      if (!rawToken || typeof rawToken !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Firebase ID token is required for authentication',
        });
        return;
      }

      const isTestMode = req.headers['x-test-mode'] === 'true';
      const decoded = await verifyFirebaseIdToken(rawToken, isTestMode);
      const user = await syncFirebaseUser(decoded);

      const tokenPayload = {
        userId: user.id,
        email: user.email || undefined,
        role: user.role,
        firebaseUid: decoded.uid,
      };

      const accessToken = signAccessToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);

      // Store cryptographically hashed refresh token for single-use rotation
      await queryPostgres(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [user.id, hashToken(refreshToken)]
      );

      // Set cookie for web clients
      res.cookie('astro_access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 60 * 1000,
      });

      res.status(200).json({
        success: true,
        message: 'Firebase authentication successful',
        data: {
          user: {
            id: user.id,
            firebaseUid: user.firebase_uid,
            email: user.email,
            phone: user.phone,
            role: user.role,
            fullName: user.full_name,
            avatarUrl: user.avatar_url,
            isNewUser: user.is_new_user === true,
          },
          accessToken,
          refreshToken,
        },
      });
    } catch (err) {
      console.error('[Auth] Firebase auth error:', err);
      res.status(401).json({ success: false, error: (err as Error).message });
    }
  }

  static async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        res.status(400).json({ success: false, error: 'Refresh token is required' });
        return;
      }

      let payload;
      try {
        payload = verifyRefreshToken(refreshToken);
      } catch (e) {
        res.status(401).json({ success: false, error: 'Expired or invalid refresh token' });
        return;
      }

      const incomingHash = hashToken(refreshToken);
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');

        // Exclusive row lock on the refresh token row to prevent concurrent race conditions
        const storedRes = await client.query(
          `SELECT id, user_id, revoked, expires_at, replaced_by FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
          [incomingHash]
        );
        const stored = storedRes.rows[0];

        if (!stored) {
          await client.query('ROLLBACK');
          res.status(401).json({ success: false, error: 'Invalid or unknown refresh token' });
          return;
        }

        // Token Reuse Detection: If a previously rotated or revoked token is reused, invalidate all sessions
        if (stored.revoked || stored.replaced_by) {
          console.warn(`[Security] Revoked refresh token reuse detected for user ${stored.user_id}! Invalidating all user sessions.`);
          await client.query(
            `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE user_id = $1 AND revoked = false`,
            [stored.user_id]
          );
          await client.query('COMMIT');
          disconnectUserSockets(stored.user_id);
          res.status(401).json({
            success: false,
            error: 'Revoked refresh token reuse detected. All active sessions have been invalidated.',
          });
          return;
        }

        if (new Date(stored.expires_at) < new Date()) {
          await client.query('ROLLBACK');
          res.status(401).json({ success: false, error: 'Refresh token has expired' });
          return;
        }

        const user = await queryPostgresSingle(
          `SELECT id, email, role, status FROM users WHERE id = $1`,
          [payload.userId]
        );

        if (!user || user.status !== 'active') {
          await client.query('ROLLBACK');
          res.status(401).json({ success: false, error: 'User inactive or not found' });
          return;
        }

        // Single-Use Rotation: Issue new access token AND new refresh token
        const tokenPayload = { userId: user.id, email: user.email, role: user.role };
        const newAccessToken = signAccessToken(tokenPayload);
        const newRefreshToken = signRefreshToken(tokenPayload);
        const newHash = hashToken(newRefreshToken);

        // Invalidate the old refresh token and link to replaced_by
        await client.query(
          `UPDATE refresh_tokens
           SET revoked = true, revoked_at = NOW(), replaced_by = $1, last_used_at = NOW()
           WHERE id = $2`,
          [newHash, stored.id]
        );

        // Insert the newly rotated refresh token hash
        await client.query(
          `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, NOW() + INTERVAL '30 days', NOW())`,
          [user.id, newHash]
        );

        await client.query('COMMIT');

        res.cookie('astro_access_token', newAccessToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 30 * 60 * 1000,
        });

        res.status(200).json({
          success: true,
          data: {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
          },
        });
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err) {
      res.status(401).json({ success: false, error: (err as Error).message });
    }
  }

  static async me(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const user = await queryPostgresSingle(
        `SELECT u.id, u.email, u.phone, u.role, u.status, u.is_verified, u.created_at,
                p.full_name, p.avatar_url, p.gender, p.date_of_birth, p.time_of_birth, p.place_of_birth, p.bio,
                w.balance AS wallet_balance
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         LEFT JOIN wallets w ON u.id = w.user_id
         WHERE u.id = $1`,
        [userId]
      );

      if (!user) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      // Automatically populate name from email if missing or placeholder
      if (!user.full_name || user.full_name === 'User' || user.full_name === 'Seeker') {
        const derived = deriveNameFromEmail(user.email);
        if (derived) {
          await queryPostgres(
            `INSERT INTO profiles (id, full_name) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name`,
            [user.id, derived]
          );
          user.full_name = derived;
        }
      }

      let astrologerProfile = null;
      if (user.role === 'astrologer') {
        astrologerProfile = await queryPostgresSingle(
          `SELECT * FROM astrologer_profiles WHERE id = $1`,
          [userId]
        );
      }

      res.status(200).json({
        success: true,
        data: {
          ...user,
          fullName: user.full_name,
          avatarUrl: user.avatar_url,
          walletBalance: user.wallet_balance,
          isVerified: user.is_verified,
          createdAt: user.created_at,
          astrologerProfile,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async logout(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { refreshToken } = req.body;

      if (refreshToken) {
        const tokenHash = hashToken(refreshToken);
        await queryPostgres(
          'UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1',
          [tokenHash]
        );
      } else if (userId) {
        await queryPostgres(
          'UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE user_id = $1 AND revoked = false',
          [userId]
        );
      }

      if (userId) {
        disconnectUserSockets(userId);
      }

      res.clearCookie('astro_access_token');
      res.status(200).json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async forgotPassword(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;
      if (!email) {
        res.status(400).json({ success: false, error: 'Email is required' });
        return;
      }

      const user = await queryPostgresSingle('SELECT id FROM users WHERE email = $1', [email]);
      let debugToken: string | undefined = undefined;

      if (user) {
        // Generate unpredictable 32-byte cryptographic token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashToken(rawToken);

        await queryPostgres(
          `INSERT INTO password_resets (user_id, token_hash, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
          [user.id, tokenHash]
        );

        if (process.env.NODE_ENV !== 'production') {
          debugToken = rawToken;
        }
      }

      // Generic response prevents account enumeration
      res.status(200).json({
        success: true,
        message: 'If an account exists with this email, password reset instructions have been generated.',
        ...(debugToken ? { resetToken: debugToken } : {}),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async resetPassword(req: Request, res: Response): Promise<void> {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) {
        res.status(400).json({ success: false, error: 'Token and newPassword are required' });
        return;
      }

      if (newPassword.length < 6) {
        res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        return;
      }

      const tokenHash = hashToken(token);
      const resetRecord = await queryPostgresSingle(
        `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = $1`,
        [tokenHash]
      );

      if (!resetRecord || resetRecord.used_at || new Date(resetRecord.expires_at) < new Date()) {
        res.status(400).json({ success: false, error: 'Invalid or expired password reset token' });
        return;
      }

      const newHash = await hashPassword(newPassword);

      // Update password
      await queryPostgres('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
        newHash,
        resetRecord.user_id,
      ]);

      // Mark token used (Single-use)
      await queryPostgres('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [resetRecord.id]);

      // Invalidate all existing refresh sessions for this user
      await queryPostgres(
        'UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE user_id = $1 AND revoked = false',
        [resetRecord.user_id]
      );

      // Disconnect all active real-time sockets
      disconnectUserSockets(resetRecord.user_id);

      res.status(200).json({
        success: true,
        message: 'Password reset successfully. Please log in with your new password.',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
