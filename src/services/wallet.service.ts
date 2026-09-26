import { queryPostgres, queryPostgresSingle, pgPool } from '../config/db.js';

export interface WalletInfo {
  userId: string;
  balance: number;
  currency: string;
  updatedAt: string;
}

export interface WalletTransactionItem {
  id: string;
  walletId: string;
  amount: number;
  type: 'credit' | 'debit';
  balanceAfter: number;
  referenceType: string;
  referenceId?: string;
  description?: string;
  createdAt: string;
}

export class WalletService {
  /**
   * Fetch user wallet and ensure it exists in PostgreSQL
   */
  static async getWallet(userId: string): Promise<{ balance: number; currency: string; transactions: any[] }> {
    let wallet = await queryPostgresSingle('SELECT * FROM wallets WHERE user_id = $1', [userId]);

    if (!wallet) {
      wallet = await queryPostgresSingle(
        `INSERT INTO wallets (user_id, balance, currency, updated_at)
         VALUES ($1, 0.00, 'INR', NOW())
         ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [userId]
      );
    }

    const transactions = await queryPostgres(
      'SELECT * FROM wallet_transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId]
    );

    return {
      balance: Number(wallet.balance),
      currency: wallet.currency || 'INR',
      transactions: transactions || [],
    };
  }

  /**
   * Atomic row-locked wallet credit
   */
  static async creditWallet(
    userId: string,
    amount: number,
    referenceType: string,
    referenceId?: string,
    description?: string,
    idempotencyKey?: string
  ): Promise<{ balance: number; transactionId?: string }> {
    if (amount <= 0) {
      throw new Error('Credit amount must be positive');
    }

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // Ensure wallet row exists and acquire exclusive row lock to serialize concurrent operations
      await client.query(
        `INSERT INTO wallets (user_id, balance, currency, updated_at)
         VALUES ($1, 0, 'INR', NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
      await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);

      // Check idempotency under row lock
      if (referenceId) {
        const existingTx = await client.query(
          'SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_type = $2 AND reference_id = $3',
          [userId, referenceType, referenceId]
        );
        if (existingTx.rows.length > 0) {
          const w = await client.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
          await client.query('COMMIT');
          return {
            balance: Number(w.rows[0].balance),
            transactionId: existingTx.rows[0].id,
          };
        }
      }

      // Update wallet balance
      const walletRes = await client.query(
        `UPDATE wallets
         SET balance = wallets.balance + $2,
             updated_at = NOW()
         WHERE user_id = $1
         RETURNING balance`,
        [userId, amount]
      );

      const newBalance = Number(walletRes.rows[0].balance);

      // Record immutable ledger entry
      const txRes = await client.query(
        `INSERT INTO wallet_transactions (
           wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
         ) VALUES ($1, $2, 'credit', $3, $4, $5, $6, NOW())
         RETURNING id`,
        [userId, amount, newBalance, referenceType, referenceId || null, description || `Credit ₹${amount.toFixed(2)}`]
      );

      await client.query('COMMIT');
      return {
        balance: newBalance,
        transactionId: txRes.rows[0]?.id,
      };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      // If unique constraint caught concurrent duplicate insert, return existing transaction
      if (err?.code === '23505' && referenceId) {
        const existing = await queryPostgresSingle(
          'SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_type = $2 AND reference_id = $3',
          [userId, referenceType, referenceId]
        );
        const w = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
        if (existing && w) {
          return {
            balance: Number(w.balance),
            transactionId: existing.id,
          };
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic row-locked wallet debit with balance validation
   */
  static async debitWallet(
    userId: string,
    amount: number,
    referenceType: string,
    referenceId?: string,
    description?: string,
    idempotencyKey?: string
  ): Promise<{ balance: number; transactionId: string }> {
    if (amount <= 0) {
      throw new Error('Debit amount must be positive');
    }

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // Lock wallet row FIRST before idempotency check to serialize concurrent requests
      const walletRes = await client.query(
        'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );

      if (walletRes.rows.length === 0) {
        throw new Error(`Wallet not found for user ${userId}`);
      }

      // Check idempotency under row lock
      if (referenceId) {
        const existingTx = await client.query(
          'SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_type = $2 AND reference_id = $3',
          [userId, referenceType, referenceId]
        );
        if (existingTx.rows.length > 0) {
          const w = await client.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
          await client.query('COMMIT');
          return {
            balance: Number(w.rows[0].balance),
            transactionId: existingTx.rows[0].id,
          };
        }
      }

      const currentBalance = Number(walletRes.rows[0].balance);
      if (currentBalance < amount) {
        throw new Error(
          `Insufficient wallet balance: available ₹${currentBalance.toFixed(2)}, required ₹${amount.toFixed(2)}`
        );
      }

      const newBalance = currentBalance - amount;

      await client.query(
        'UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2',
        [newBalance, userId]
      );

      const txRes = await client.query(
        `INSERT INTO wallet_transactions (
           wallet_id, amount, type, balance_after, reference_type, reference_id, description, created_at
         ) VALUES ($1, $2, 'debit', $3, $4, $5, $6, NOW())
         RETURNING id`,
        [userId, amount, newBalance, referenceType, referenceId || null, description || `Debit ₹${amount.toFixed(2)}`]
      );

      await client.query('COMMIT');
      return {
        balance: newBalance,
        transactionId: txRes.rows[0].id,
      };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (err?.code === '23505' && referenceId) {
        const existing = await queryPostgresSingle(
          'SELECT * FROM wallet_transactions WHERE wallet_id = $1 AND reference_type = $2 AND reference_id = $3',
          [userId, referenceType, referenceId]
        );
        const w = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
        if (existing && w) {
          return {
            balance: Number(w.balance),
            transactionId: existing.id,
          };
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Query transactions with pagination
   */
  static async getTransactions(userId: string, limit = 50, offset = 0): Promise<WalletTransactionItem[]> {
    const rows = await queryPostgres(
      `SELECT * FROM wallet_transactions
       WHERE wallet_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return rows.map((r: any) => ({
      id: r.id,
      walletId: r.wallet_id,
      amount: Number(r.amount),
      type: r.type,
      balanceAfter: Number(r.balance_after),
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      description: r.description,
      createdAt: r.created_at,
    }));
  }
}
