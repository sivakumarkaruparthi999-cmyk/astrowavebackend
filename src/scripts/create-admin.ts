import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { pgPool, queryPostgres, queryPostgresSingle } from '../config/db.js';
import { hashPassword } from '../auth/jwt.js';

const __filename = fileURLToPath(import.meta.url);

export async function createOrUpdateAdmin(closePool: boolean = true) {
  const configuredEmail = (process.env.ADMIN_EMAIL || process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || 'Admin@123456';

  const targetEmails = new Set<string>();
  if (configuredEmail) {
    targetEmails.add(configuredEmail);
  }
  // Ensure both standard admin aliases are synchronized
  targetEmails.add('admin@astro.com');
  targetEmails.add('admin@astroo.com');

  const client = await pgPool.connect();
  try {
    const passwordHash = await hashPassword(envPassword);

    for (const email of targetEmails) {
      const existing = await queryPostgresSingle(
        'SELECT id, role, password_hash, status FROM users WHERE LOWER(TRIM(email)) = $1',
        [email]
      );

      if (existing) {
        await queryPostgres(
          `UPDATE users
           SET password_hash = $1, role = 'super_admin', status = 'active', is_verified = true, updated_at = NOW()
           WHERE id = $2`,
          [passwordHash, existing.id]
        );
        console.log(`[Admin Setup] Successfully updated admin account credentials, status=active, role=super_admin for: ${email}`);
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

        console.log(`[Admin Setup] Successfully created new super_admin account for: ${email}`);
      }
    }

    console.log('[Admin Setup] All administrator accounts synchronized successfully.');
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

