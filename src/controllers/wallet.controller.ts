import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { WalletService } from '../services/wallet.service.js';

export class WalletController {
  static async getWallet(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const wallet = await WalletService.getWallet(userId);
      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getTransactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const transactions = await WalletService.getTransactions(userId, limit, offset);
      res.status(200).json({ success: true, data: transactions });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
