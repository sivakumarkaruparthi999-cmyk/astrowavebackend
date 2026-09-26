import { queryPostgres } from '../config/db.js';

export class TransactionService {
  /**
   * Get unified transactions across wallet ledger
   */
  static async getUserLedger(userId: string, limit = 50, offset = 0): Promise<any[]> {
    const rows = await queryPostgres(
      `SELECT wt.*, c.rate_per_minute, cb.billed_minutes
       FROM wallet_transactions wt
       LEFT JOIN consultation_billing cb ON wt.id = cb.wallet_transaction_id
       LEFT JOIN consultations c ON cb.consultation_id = c.id
       WHERE wt.wallet_id = $1
       ORDER BY wt.created_at DESC
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

  /**
   * Admin ledger audit across all users and providers
   */
  static async getSystemLedger(limit = 100, offset = 0): Promise<any[]> {
    const rows = await queryPostgres(
      `SELECT wt.*, u.email, u.phone, u.role
       FROM wallet_transactions wt
       JOIN users u ON wt.wallet_id = u.id
       ORDER BY wt.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return rows.map((r: any) => ({
      id: r.id,
      userId: r.wallet_id,
      userEmail: r.email,
      userPhone: r.phone,
      userRole: r.role,
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
