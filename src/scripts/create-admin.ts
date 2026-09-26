import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { pgPool, queryPostgres, queryPostgresSingle } from '../config/db.js';
import { hashPassword } from '../auth/jwt.js';

const __filename = fileURLToPath(import.meta.url);

export async function createOrUpdateAdmin(closePool: boolean = true) {
  const email = process.env.ADMIN_EMAIL || process.env.INITIAL_ADMIN_EMAIL || 'admin@astroo.com';
  const envPassword = process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD;

  const client = await pgPool.connect();
  try {
    const existing = await queryPostgresSingle(
      'SELECT id, role, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (existing) {
      if (envPassword) {
        const passwordHash = await hashPassword(envPassword);
        await queryPostgres(
          `UPDATE users
           SET password_hash = $1, role = 'super_admin', status = 'active', is_verified = true, updated_at = NOW()
           WHERE id = $2`,
          [passwordHash, existing.id]
        );
        console.log(`[Admin Setup] Successfully updated existing user ${email} credentials and role to super_admin.`);
      } else {
        await queryPostgres(
          `UPDATE users
           SET role = 'super_admin', status = 'active', is_verified = true, updated_at = NOW()
           WHERE id = $1`,
          [existing.id]
        );
        console.log(`[Admin Setup] Confirmed super_admin role for existing user ${email}.`);
      }
    } else {
      const passwordToUse = envPassword || 'Admin@123456';
      const passwordHash = await hashPassword(passwordToUse);

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

    console.log('[Admin Setup] Super admin account configuration completed.');
  } catch (err) {
    console.error('[Admin Setup] Failed to create/update admin:', err);
    if (closePool) {
      process.exit(1);
    }
    throw err;
  } finally {
    client.release();
    if (closePool) {
      await pgPool.end();
    }
  }
}

const isDirectEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectEntrypoint) {
  createOrUpdateAdmin(true);
}

