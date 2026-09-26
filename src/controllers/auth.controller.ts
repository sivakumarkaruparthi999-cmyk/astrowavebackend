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

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export class AuthController {
  static async register(req: Request, res: Response): Promise<void> {
    try {
      const { email, phone, password, fullName, role = 'customer' } = req.body;

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

      const passwordHash = await hashPassword(password);
      const isVerifiedInitial = role === 'customer';
      const user = await queryPostgresSingle(
        `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
         VALUES ($1, $2, $3, $4, 'active', $5)
         RETURNING id, email, phone, role, status, is_verified, created_at`,
        [email || null, phone || null, passwordHash, role, isVerifiedInitial]
      );

      // Create profile
      await queryPostgres(
        `INSERT INTO profiles (id, full_name) VALUES ($1, $2)`,
        [user.id, fullName || 'User']
      );

      // Create wallet with initial zero balance
      await queryPostgres(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.00) ON CONFLICT DO NOTHING`,
        [user.id]
      );

      // If astrologer, create astrologer_profile with pending verification
      if (role === 'astrologer') {
        await queryPostgres(
          `INSERT INTO astrologer_profiles (id, display_name, is_verified, verification_status)
           VALUES ($1, $2, false, 'pending')
           ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
          [user.id, fullName || 'Astrologer']
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
            fullName: fullName || 'User',
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

      const user = await queryPostgresSingle(
        `SELECT u.id, u.email, u.phone, u.password_hash, u.role, u.status, p.full_name, p.avatar_url
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         WHERE (u.email IS NOT NULL AND u.email = $1) OR (u.phone IS NOT NULL AND u.phone = $2)`,
        [email || null, phone || null]
      );

      if (!user) {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
      }

      if (user.status === 'blocked' || user.status === 'suspended') {
        res.status(403).json({ success: false, error: `Account is ${user.status}. Please contact support.` });
        return;
      }

      const isMatch = await comparePassword(password, user.password_hash);
      if (!isMatch) {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
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
            avatarUrl: user.avatar_url,
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
          const ticket = await googleClient.verifyIdToken({
            idToken: rawToken,
            audience: process.env.GOOGLE_CLIENT_ID ? [process.env.GOOGLE_CLIENT_ID] : undefined,
          });
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
          res.status(401).json({
            success: false,
            error: 'Google ID token verification failed: ' + (verifyErr as Error).message,
          });
          return;
        }
      }

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
          [newUser.id, verifiedName, verifiedPicture]
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
          full_name: verifiedName,
          avatar_url: verifiedPicture,
        };
      } else {
        if (user.status === 'blocked' || user.status === 'suspended') {
          res.status(403).json({ success: false, error: `Account is ${user.status}. Please contact support.` });
          return;
        }

        if (verifiedPicture && !user.avatar_url) {
          await queryPostgres('UPDATE profiles SET avatar_url = $1 WHERE id = $2', [verifiedPicture, user.id]);
          user.avatar_url = verifiedPicture;
        }
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
            avatarUrl: user.avatar_url,
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
