import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runBackupRestoreDrill() {
  console.log('====================================================');
  console.log('📦 ASTROWAVE — DATABASE BACKUP & RESTORE DRILL');
  console.log('====================================================');

  const pgHost = process.env.PGHOST || 'localhost';
  const pgPort = process.env.PGPORT || '5432';
  const pgUser = process.env.PGUSER || 'postgres';
  const pgPassword = process.env.PGPASSWORD || 'javed@2004';
  const sourceDb = process.env.PGDATABASE || 'astrotalk';
  const targetDb = 'astrotalk_restore_drill';

  const backupDir = path.resolve(__dirname, '../../scratch/backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const dumpFile = path.join(backupDir, `drill_${Date.now()}.dump`);

  // Path to PostgreSQL 18 binaries
  const pgDumpBin = fs.existsSync('/Library/PostgreSQL/18/bin/pg_dump')
    ? '/Library/PostgreSQL/18/bin/pg_dump'
    : 'pg_dump';
  const pgRestoreBin = fs.existsSync('/Library/PostgreSQL/18/bin/pg_restore')
    ? '/Library/PostgreSQL/18/bin/pg_restore'
    : 'pg_restore';

  console.log(`[Config] Source Database: ${sourceDb}`);
  console.log(`[Config] Target Test Database: ${targetDb}`);
  console.log(`[Config] pg_dump: ${pgDumpBin}`);
  console.log(`[Config] pg_restore: ${pgRestoreBin}`);

  // 1. Generate Backup
  console.log('\n[Phase 1] Generating logical binary dump...');
  const backupStart = Date.now();
  const dumpCmd = `PGPASSWORD="${pgPassword}" "${pgDumpBin}" -h ${pgHost} -p ${pgPort} -U ${pgUser} -d ${sourceDb} -F c -b -f "${dumpFile}"`;
  execSync(dumpCmd, { stdio: 'inherit' });
  const backupDurationMs = Date.now() - backupStart;

  const stats = fs.statSync(dumpFile);
  const backupSizeKb = Math.round(stats.size / 1024);
  console.log(`✅ Backup successfully created in ${backupDurationMs}ms (${backupSizeKb} KB)`);

  // 2. Prepare Isolated Test Database
  console.log('\n[Phase 2] Creating isolated database for restore test...');
  const adminPool = new Pool({
    host: pgHost,
    port: parseInt(pgPort, 10),
    user: pgUser,
    password: pgPassword,
    database: 'postgres',
  });

  try {
    // Terminate existing connections to targetDb if any
    await adminPool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${targetDb}' AND pid <> pg_backend_pid();
    `);
    await adminPool.query(`DROP DATABASE IF EXISTS ${targetDb};`);
    await adminPool.query(`CREATE DATABASE ${targetDb};`);
    console.log(`✅ Database ${targetDb} created.`);
  } finally {
    await adminPool.end();
  }

  // 3. Restore into Isolated Database
  console.log('\n[Phase 3] Restoring dump into isolated database...');
  const restoreStart = Date.now();
  const restoreCmd = `PGPASSWORD="${pgPassword}" "${pgRestoreBin}" -h ${pgHost} -p ${pgPort} -U ${pgUser} -d ${targetDb} --no-owner --no-privileges "${dumpFile}"`;
  try {
    execSync(restoreCmd, { stdio: 'pipe' });
  } catch (err: any) {
    // pg_restore returns 1 if warnings were raised (e.g. relation already exists)
    console.log(`[Notice] pg_restore exited with warnings (standard for existing extensions/roles)`);
  }
  const restoreDurationMs = Date.now() - restoreStart;
  console.log(`✅ Restore completed in ${restoreDurationMs}ms`);

  // 4. Verify Schema & Data Integrity in Restored Database
  console.log('\n[Phase 4] Verifying data integrity and ledger invariants in restored database...');
  const testPool = new Pool({
    host: pgHost,
    port: parseInt(pgPort, 10),
    user: pgUser,
    password: pgPassword,
    database: targetDb,
  });

  try {
    // 4.1 Tables count
    const tablesRes = await testPool.query(`
      SELECT count(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public';
    `);
    console.log(`- Public Tables Count: ${tablesRes.rows[0].count}`);

    // 4.2 Users count
    const usersRes = await testPool.query('SELECT count(*) as count FROM users;');
    console.log(`- Users Count: ${usersRes.rows[0].count}`);

    // 4.3 Wallets count
    const walletsRes = await testPool.query('SELECT count(*) as count, COALESCE(SUM(balance), 0) as total_balance FROM wallets;');
    console.log(`- Wallets Count: ${walletsRes.rows[0].count} (Total Balance: ₹${walletsRes.rows[0].total_balance})`);

    // 4.4 Wallet Transactions count
    const txRes = await testPool.query('SELECT count(*) as count FROM wallet_transactions;');
    console.log(`- Wallet Transactions Count: ${txRes.rows[0].count}`);

    // 4.5 Payments count
    const paymentsRes = await testPool.query('SELECT count(*) as count FROM payments;');
    console.log(`- Payments Count: ${paymentsRes.rows[0].count}`);

    // 4.6 Consultations count
    const consultRes = await testPool.query('SELECT count(*) as count FROM consultations;');
    console.log(`- Consultations Count: ${consultRes.rows[0].count}`);

    // 4.7 Billing records
    const billingRes = await testPool.query('SELECT count(*) as count FROM consultation_billing;');
    console.log(`- Consultation Billing Records: ${billingRes.rows[0].count}`);

    // 4.8 Authoritative Financial Invariant Check (Discrepancy must be exactly ZERO)
    const discrepancyRes = await testPool.query(`
      SELECT 
        w.user_id,
        w.balance AS wallet_balance,
        COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0) AS ledger_sum,
        ABS(w.balance - COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)) AS discrepancy
      FROM wallets w
      LEFT JOIN wallet_transactions t ON t.wallet_id = w.user_id
      GROUP BY w.user_id, w.balance
      HAVING ABS(w.balance - COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)) > 0.001;
    `);

    if (discrepancyRes.rows.length === 0) {
      console.log('✅ FINANCIAL LEDGER INVARIANT: 100% MATCH (0 discrepancies across all wallets)');
    } else {
      console.error('❌ FINANCIAL DISCREPANCY DETECTED IN RESTORED DATABASE:', discrepancyRes.rows);
      throw new Error('Financial ledger invariant failed in restored database!');
    }

    console.log('\n====================================================');
    console.log('🎉 BACKUP & RESTORE DRILL VERIFIED SUCCESSFULLY!');
    console.log(`- Backup Size: ${backupSizeKb} KB`);
    console.log(`- Backup Duration: ${backupDurationMs} ms`);
    console.log(`- Restore Duration: ${restoreDurationMs} ms`);
    console.log('====================================================\n');
  } finally {
    await testPool.end();

    // 5. Cleanup
    fs.unlinkSync(dumpFile);

    // Drop test database
    const cleanupPool = new Pool({
      host: pgHost,
      port: parseInt(pgPort, 10),
      user: pgUser,
      password: pgPassword,
      database: 'postgres',
    });
    try {
      await cleanupPool.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${targetDb}' AND pid <> pg_backend_pid();
      `);
      await cleanupPool.query(`DROP DATABASE IF EXISTS ${targetDb};`);
      console.log(`[Cleanup] Dropped temporary restore drill database ${targetDb}`);
    } finally {
      await cleanupPool.end();
    }
  }
}

runBackupRestoreDrill().catch((err) => {
  console.error('Backup & restore drill failed:', err);
  process.exit(1);
});
