import { queryPostgres, queryPostgresSingle } from '../config/db.js';

export class PayoutService {
  /**
   * Request payout with balance lock
   */
  static async requestPayout(providerId: string, amount: number, payoutAccountId?: string): Promise<any> {
    if (!amount || amount <= 0) {
      throw new Error('Valid payout amount is required');
    }

    const earnings = await queryPostgresSingle(
      'SELECT available_balance FROM provider_earnings WHERE provider_id = $1',
      [providerId]
    );

    const available = earnings ? Number(earnings.available_balance) : 0;
    if (available < amount) {
      throw new Error(`Insufficient available balance: ₹${available.toFixed(2)} available, ₹${amount} requested`);
    }

    // Deduct from available, move to pending
    await queryPostgres(
      `UPDATE provider_earnings
       SET available_balance = available_balance - $1,
           pending_payout_amount = pending_payout_amount + $1,
           updated_at = NOW()
       WHERE provider_id = $2`,
      [amount, providerId]
    );

    const payoutRequest = await queryPostgresSingle(
      `INSERT INTO payout_requests (provider_id, payout_account_id, amount, status)
       VALUES ($1, $2, $3, 'REQUESTED')
       RETURNING *`,
      [providerId, payoutAccountId || null, amount]
    );

    return payoutRequest;
  }

  /**
   * Admin process payout
   */
  static async processPayout(
    payoutRequestId: string,
    adminId: string,
    action: 'APPROVE' | 'REJECT' | 'COMPLETE',
    notes?: string,
    bankReference?: string
  ): Promise<void> {
    await queryPostgres(
      'SELECT process_payout_approval($1, $2, $3, $4, $5)',
      [payoutRequestId, adminId, action, notes || null, bankReference || null]
    );
  }
}
