import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pgPool } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSeed() {
  if (process.env.NODE_ENV === 'production') {
    console.error('[Seed] FATAL: Seeding dummy data is disabled in production environment.');
    process.exit(1);
  }

  console.log('[Seed] Seeding database with initial platform data...');
  const client = await pgPool.connect();
  try {
    const filePath = path.join(__dirname, '003_seed.sql');

    if (fs.existsSync(filePath)) {
      console.log(`[Seed] Executing 003_seed.sql...`);
      const sql = fs.readFileSync(filePath, 'utf8');
      await client.query(sql);
      console.log(`[Seed] Successfully seeded initial users, astrologers, pooja services, and wallets!`);
    } else {
      console.warn(`[Seed] File not found: ${filePath}`);
    }
  } catch (error) {
    console.error('[Seed] Failed to seed database:', error);
    process.exit(1);
  } finally {
    client.release();
    await pgPool.end();
  }
}

runSeed();
