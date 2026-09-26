import crypto from 'crypto';
import { pgPool, queryPostgres, queryPostgresSingle } from '../config/db.js';
import { hashPassword } from '../auth/jwt.js';

async function createOrUpdateAdmin() {
  const email = process.env.ADMIN_EMAIL || process.env.INITIAL_ADMIN_EMAIL;
  let password = process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD;

  if (!email) {
    console.error('Usage: ADMIN_EMAIL=admin@example.com [ADMIN_PASSWORD=securepass] npx tsx src/scripts/create-admin.ts');
    process.exit(1);
  }

  let generated = false;
  if (!password) {
    password = crypto.randomBytes(16).toString('base64url');
    generated = true;
  }

  const client = await pgPool.connect();
  try {
    const existing = await queryPostgresSingle(
      'SELECT id, role FROM users WHERE email = $1',
      [email]
    );

    const passwordHash = await hashPassword(password);

    if (existing) {
      await queryPostgres(
        `UPDATE users
         SET password_hash = $1, role = 'super_admin', status = 'active', is_verified = true, updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, existing.id]
      );
      console.log(`[Admin Setup] Successfully updated existing user ${email} to super_admin.`);
    } else {
      const user = await queryPostgresSingle(
        `INSERT INTO users (email, password_hash, role, status, is_verified)
         VALUES ($1, $2, 'super_admin', 'active', true)
         RETURNING id`,
        [email, passwordHash]
      );

      await queryPostgres(
        `INSERT INTO profiles (id, full_name, bio)
         VALUES ($1, 'System Administrator', 'Platform Super Administrator')
         ON CONFLICT (id) DO NOTHING`,
        [user.id]
      );

      console.log(`[Admin Setup] Successfully created new super_admin with email: ${email}`);
    }

    if (generated) {
      console.log(`[Admin Setup] A secure password was generated: ${password}`);
      console.log(`[Admin Setup] Please store this password securely and change it upon first login.`);
    } else {
      console.log(`[Admin Setup] Password set from environment.`);
    }
  } catch (err) {
    console.error('[Admin Setup] Failed to create/update admin:', err);
    process.exit(1);
  } finally {
    client.release();
    await pgPool.end();
  }
}

createOrUpdateAdmin();
