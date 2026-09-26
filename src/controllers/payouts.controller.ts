import { Response } from 'express';
import { pgPool, queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';

export class PayoutsController {
  static async requestPayout(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const providerId = req.user?.userId;
      const { amount, payoutAccountId } = req.body;

      if (!amount || amount <= 0) {
        res.status(400).json({ success: false, error: 'Valid payout amount is required' });
        return;
      }

      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');

        // Authorization check: Verify payout account ownership if specified
        if (payoutAccountId) {
          const accountRes = await client.query(
            'SELECT id FROM payout_accounts WHERE id = $1 AND provider_id = $2',
            [payoutAccountId, providerId]
          );
          if (accountRes.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(403).json({
              success: false,
              error: 'Unauthorized: Payout account does not exist or does not belong to your profile',
            });
            return;
          }
        }

        // Exclusive row lock on provider_earnings to prevent race conditions & double withdrawal
        const earningsRes = await client.query(
          'SELECT available_balance FROM provider_earnings WHERE provider_id = $1 FOR UPDATE',
          [providerId]
        );

        const available = earningsRes.rows[0] ? Number(earningsRes.rows[0].available_balance) : 0;
        if (available < amount) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            error: `Insufficient available balance: ₹${available.toFixed(2)} available, ₹${amount} requested`,
          });
          return;
        }

        // Deduct from available, move to pending
        await client.query(
          `UPDATE provider_earnings
           SET available_balance = available_balance - $1,
               pending_payout_amount = pending_payout_amount + $1,
               updated_at = NOW()
           WHERE provider_id = $2`,
          [amount, providerId]
        );

        const payoutRes = await client.query(
          `INSERT INTO payout_requests (provider_id, payout_account_id, amount, status)
           VALUES ($1, $2, $3, 'REQUESTED')
           RETURNING *`,
          [providerId, payoutAccountId || null, amount]
        );

        await client.query('COMMIT');

        res.status(201).json({
          success: true,
          message: 'Payout request submitted successfully',
          data: payoutRes.rows[0],
        });
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listAccounts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const providerId = req.user?.userId;
      const accounts = await queryPostgres(
        'SELECT * FROM payout_accounts WHERE provider_id = $1 ORDER BY is_primary DESC, created_at DESC',
        [providerId]
      );
      res.status(200).json({ success: true, data: accounts || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async addAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const providerId = req.user?.userId;
      const { accountType, accountHolderName, accountNumber, ifscCode, upiId, isPrimary } = req.body;

      if (!accountType || !accountHolderName) {
        res.status(400).json({ success: false, error: 'Account type and holder name are required' });
        return;
      }

      if (isPrimary) {
        await queryPostgres('UPDATE payout_accounts SET is_primary = false WHERE provider_id = $1', [providerId]);
      }

      const account = await queryPostgresSingle(
        `INSERT INTO payout_accounts (provider_id, account_type, account_holder_name, account_number, ifsc_code, upi_id, is_primary, is_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         RETURNING *`,
        [providerId, accountType, accountHolderName, accountNumber || null, ifscCode || null, upiId || null, isPrimary ?? true]
      );

      res.status(201).json({ success: true, message: 'Payout account added', data: account });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async processPayout(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const adminId = req.user?.userId;
      const { payoutRequestId, action, notes, bankReference } = req.body;

      if (!payoutRequestId || !action) {
        res.status(400).json({ success: false, error: 'Payout request ID and action (APPROVE/REJECT/COMPLETE) are required' });
        return;
      }

      await queryPostgres(
        'SELECT process_payout_approval($1, $2, $3, $4, $5)',
        [payoutRequestId, adminId, action, notes || null, bankReference || null]
      );

      const updated = await queryPostgresSingle('SELECT * FROM payout_requests WHERE id = $1', [payoutRequestId]);
      res.status(200).json({ success: true, message: `Payout request ${action.toLowerCase()}d successfully`, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
