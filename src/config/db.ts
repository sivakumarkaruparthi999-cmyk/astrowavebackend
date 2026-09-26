import pkg from 'pg';
const { Pool, types } = pkg;
import type { PoolConfig } from 'pg';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Parse PostgreSQL NUMERIC/DECIMAL (OID 1700) as float numbers
types.setTypeParser(1700, (val: string) => parseFloat(val));
types.setTypeParser(20, (val: string) => parseInt(val, 10)); // INT8

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded from process.cwd() or backend directory
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function getPgPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined;

  // Support standard PostgreSQL (PG*) and alternative (POSTGRES_*) environment variables
  const host = process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost';
  const portStr = process.env.PGPORT || process.env.POSTGRES_PORT || '5432';
  const port = parseInt(portStr, 10);
  const database = process.env.PGDATABASE || process.env.POSTGRES_DB || process.env.POSTGRES_DATABASE || 'astrotalk';
  const user = process.env.PGUSER || process.env.POSTGRES_USER || 'postgres';
  const password = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD;

  const statementTimeout = parseInt(process.env.PG_STATEMENT_TIMEOUT || '15000', 10);

  if (connectionString) {
    return {
      connectionString,
      ssl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: statementTimeout,
      query_timeout: statementTimeout,
    };
  }

  return {
    host,
    port,
    database,
    user,
    ...(password !== undefined ? { password: String(password) } : {}),
    ssl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout,
  };
}

export const pgPool = new Pool(getPgPoolConfig());

export async function queryPostgres<T = any>(text: string, params?: any[]): Promise<T[]> {
  const client = await pgPool.connect();
  try {
    const res = await client.query(text, params);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

export async function queryPostgresSingle<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await queryPostgres<T>(text, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Execute a callback within an isolated client session with RLS user context
 */
export async function withUserContext<T = any>(
  userId: string,
  role: string,
  fn: (client: pkg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_user_id = $1`, [userId]);
    await client.query(`SET LOCAL app.current_user_role = $2`, [role]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function connectMongo(): Promise<typeof mongoose | null> {
  const rawMongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/astrotalk';
  const redactedUri = rawMongoUri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:REDACTED@');
  try {
    mongoose.set('bufferCommands', false);
    const conn = await mongoose.connect(rawMongoUri, {
      serverSelectionTimeoutMS: 2000,
      bufferCommands: false,
    });
    console.log(`[MongoDB] Connected successfully to ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`[DB-01 Production Blocker] MongoDB connection failed: ${(error as Error).message}. Silent in-memory fallback is forbidden in production.`);
    }
    console.warn(`[MongoDB] Warning: MongoDB connection to ${redactedUri} failed (${(error as Error).message}). Real-time fallback memory store will be used.`);
    return null;
  }
}

export async function checkDatabaseHealth(): Promise<{ postgres: boolean; mongo: boolean }> {
  let postgresOk = false;
  let mongoOk = false;

  try {
    const pgRes = await pgPool.query('SELECT 1 AS healthy');
    postgresOk = pgRes.rows.length > 0;
  } catch (err) {
    postgresOk = false;
  }

  try {
    mongoOk = mongoose.connection.readyState === 1;
  } catch (err) {
    mongoOk = false;
  }

  return { postgres: postgresOk, mongo: mongoOk };
}
