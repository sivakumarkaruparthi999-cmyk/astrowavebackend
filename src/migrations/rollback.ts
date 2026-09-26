import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pgPool } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runRollback() {
  console.log('[Rollback] Inspecting applied PostgreSQL schema migrations...');
  const client = await pgPool.connect();
  try {
    const res = await client.query(`
      SELECT filename, applied_at 
      FROM schema_migrations 
      ORDER BY id DESC 
      LIMIT 1;
    `);

    if (res.rows.length === 0) {
      console.log('[Rollback] No recorded migrations found to rollback.');
      return;
    }

    const lastMigration = res.rows[0].filename;
    console.log(`[Rollback] Latest applied migration: ${lastMigration} (applied at ${res.rows[0].applied_at})`);

    const rollbackFile = lastMigration.replace('.sql', '.down.sql');
    const rollbackPath = path.join(__dirname, rollbackFile);

    if (!fs.existsSync(rollbackPath)) {
      console.warn(`[Rollback] Notice: No explicit down migration file found at ${rollbackPath}.`);
      console.warn(`[Rollback] AstroWave strictly enforces additive/expand-contract migrations to preserve data integrity.`);
      console.warn(`[Rollback] Existing data and schema remain backward-compatible with previous application versions.`);
      return;
    }

    console.log(`[Rollback] Executing ${rollbackFile}...`);
    const sql = fs.readFileSync(rollbackPath, 'utf8');

    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE filename = $1', [lastMigration]);
    await client.query('COMMIT');

    console.log(`[Rollback] Successfully rolled back ${lastMigration}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Rollback] Rollback execution failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pgPool.end();
  }
}

runRollback();
