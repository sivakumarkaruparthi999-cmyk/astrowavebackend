import crypto from 'crypto';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { hashPassword } from '../auth/jwt.js';
import { DecodedFirebaseToken } from './firebase.service.js';

export interface SyncedUser {
  id: string;
  firebase_uid?: string;
  email?: string | null;
  phone?: string | null;
  role: string;
  status: string;
  is_verified: boolean;
  full_name?: string | null;
  avatar_url?: string | null;
  created_at?: Date;
  last_login_at?: Date;
  is_new_user?: boolean;
}

/**
 * Synchronizes a verified Firebase identity with the PostgreSQL users, profiles, and wallets tables.
 * Handles identity lookup, account linking by verified email or phone, and safe creation of new customer accounts.
 */
export async function syncFirebaseUser(decoded: DecodedFirebaseToken): Promise<SyncedUser> {
  const { uid, email, phone_number, name, picture, sign_in_provider } = decoded;

  // 1. Direct Lookup by Firebase UID
  let user = await queryPostgresSingle(
    `SELECT u.id, u.firebase_uid, u.email, u.phone, u.role, u.status, u.is_verified, u.created_at, u.last_login_at,
            p.full_name, p.avatar_url
     FROM users u
     LEFT JOIN profiles p ON u.id = p.id
     WHERE u.firebase_uid = $1`,
    [uid]
  );

  if (user) {
    if (user.status === 'blocked' || user.status === 'suspended') {
      throw new Error(`Account is ${user.status}. Please contact support.`);
    }

    // Update last_login_at timestamp and sync avatar/name if missing
    await queryPostgres(
      `UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    if (picture && !user.avatar_url) {
      await queryPostgres(`UPDATE profiles SET avatar_url = $1 WHERE id = $2`, [picture, user.id]);
      user.avatar_url = picture;
    }

    return {
      ...user,
      is_new_user: false,
    };
  }

  // 2. Account Linking by Verified Email or Verified Phone
  let existingByContact: any = null;

  if (email) {
    existingByContact = await queryPostgresSingle(
      `SELECT u.id, u.firebase_uid, u.email, u.phone, u.role, u.status, u.is_verified, u.created_at,
              p.full_name, p.avatar_url
       FROM users u
       LEFT JOIN profiles p ON u.id = p.id
       WHERE u.email = $1`,
      [email]
    );
  }

  if (!existingByContact && phone_number) {
    // Normalize phone comparisons (both with and without +91)
    const rawNumber = phone_number.replace(/^\+91/, '').replace(/\D/g, '');
    existingByContact = await queryPostgresSingle(
      `SELECT u.id, u.firebase_uid, u.email, u.phone, u.role, u.status, u.is_verified, u.created_at,
              p.full_name, p.avatar_url
       FROM users u
       LEFT JOIN profiles p ON u.id = p.id
       WHERE u.phone = $1 OR u.phone = $2 OR u.phone = $3`,
      [phone_number, rawNumber, `+91${rawNumber}`]
    );
  }

  if (existingByContact) {
    if (existingByContact.status === 'blocked' || existingByContact.status === 'suspended') {
      throw new Error(`Account is ${existingByContact.status}. Please contact support.`);
    }

    // Link Firebase UID to existing AstroWave user account
    await queryPostgres(
      `UPDATE users
       SET firebase_uid = $1,
           auth_provider = COALESCE(auth_provider, $2),
           last_login_at = NOW(),
           is_verified = true,
           updated_at = NOW()
       WHERE id = $3`,
      [uid, sign_in_provider || 'firebase', existingByContact.id]
    );

    if (picture && !existingByContact.avatar_url) {
      await queryPostgres(`UPDATE profiles SET avatar_url = $1 WHERE id = $2`, [picture, existingByContact.id]);
      existingByContact.avatar_url = picture;
    }

    console.log(`[UserSync] Successfully linked Firebase UID ${uid} to existing AstroWave user ${existingByContact.id}`);

    return {
      ...existingByContact,
      firebase_uid: uid,
      is_new_user: false,
    };
  }

  // 3. New User Registration
  const randomPlaceholder = 'FIREBASE_AUTH_' + crypto.randomBytes(24).toString('hex');
  const passwordPlaceholderHash = await hashPassword(randomPlaceholder);
  const provider = sign_in_provider || (phone_number ? 'phone' : 'google');
  const displayName = name || (phone_number ? `User ${phone_number.slice(-4)}` : 'AstroWave User');

  const newUser = await queryPostgresSingle(
    `INSERT INTO users (email, phone, password_hash, role, status, is_verified, firebase_uid, auth_provider, last_login_at)
     VALUES ($1, $2, $3, 'customer', 'active', true, $4, $5, NOW())
     RETURNING id, email, phone, role, status, is_verified, firebase_uid, auth_provider, created_at, last_login_at`,
    [email || null, phone_number || null, passwordPlaceholderHash, uid, provider]
  );

  // Create Profile
  await queryPostgres(
    `INSERT INTO profiles (id, full_name, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       full_name = COALESCE(profiles.full_name, EXCLUDED.full_name),
       avatar_url = COALESCE(profiles.avatar_url, EXCLUDED.avatar_url)`,
    [newUser.id, displayName, picture || null]
  );

  // Initialize Wallet with Zero Balance
  await queryPostgres(
    `INSERT INTO wallets (user_id, balance)
     VALUES ($1, 0.00)
     ON CONFLICT DO NOTHING`,
    [newUser.id]
  );

  console.log(`[UserSync] Registered new AstroWave customer ${newUser.id} via Firebase UID ${uid} (${provider})`);

  return {
    id: newUser.id,
    firebase_uid: newUser.firebase_uid,
    email: newUser.email,
    phone: newUser.phone,
    role: newUser.role,
    status: newUser.status,
    is_verified: newUser.is_verified,
    full_name: displayName,
    avatar_url: picture || null,
    created_at: newUser.created_at,
    last_login_at: newUser.last_login_at,
    is_new_user: true,
  };
}
