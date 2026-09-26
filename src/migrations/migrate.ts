import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pgPool } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(closePool: boolean = true) {
  console.log('[Migration] Starting PostgreSQL schema migration...');
  const client = await pgPool.connect();
  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Fetch already applied migrations
    const appliedResult = await client.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(appliedResult.rows.map((row: any) => row.filename));

    const files = [
      '001_schema.sql',
      '002_functions.sql',
      '004_phase2_schema.sql',
      '005_phase2_functions.sql',
      '006_phase3_sessions_and_resets.sql',
      '006_razorpay_schema.sql',
      '006_continuous_billing.sql',
      '007_phase5a_database_security.sql',
      '008_phase6_3_performance_indexes.sql',
      '009_firebase_auth.sql',
      '009_consolidate_payment_columns.sql',
      '010_reconcile_wallet_ledger.sql',
      'catalog_seed.sql',
    ];

    let appliedCount = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[Migration] Already applied: ${file} (skipping)`);
        continue;
      }

      const filePath = path.join(__dirname, file);
      if (fs.existsSync(filePath)) {
        console.log(`[Migration] Executing ${file}...`);
        const sql = fs.readFileSync(filePath, 'utf8');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`
          INSERT INTO schema_migrations (filename)
          VALUES ($1)
          ON CONFLICT (filename) DO UPDATE SET applied_at = NOW()
        `, [file]);
        await client.query('COMMIT');
        appliedCount++;
        console.log(`[Migration] Successfully applied ${file}`);
      } else {
        console.warn(`[Migration] File not found: ${filePath}`);
      }
    }
    console.log(`[Migration] All schema migrations processed. Newly applied: ${appliedCount}, Previously applied: ${appliedSet.size}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Migration] Failed to run migrations:', error);
    if (closePool) {
      process.exit(1);
    }
    throw error;
  } finally {
    client.release();
    if (closePool) {
      await pgPool.end();
    }
  }
}

// Auto-run if executed directly as entrypoint
const isDirectEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectEntrypoint) {
  runMigrations(true);
}
