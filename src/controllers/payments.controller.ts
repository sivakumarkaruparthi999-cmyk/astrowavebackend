import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { PaymentsService } from '../services/payments.service.js';

export class PaymentsController {
  static async createOrder(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const { amount, currency = 'INR', purpose, consultationId, couponCode, idempotencyKey, description } = req.body;

      const order = await PaymentsService.createOrder({
        userId,
        amount,
        currency,
        purpose,
        consultationId,
        couponCode,
        idempotencyKey,
        description,
      });

      res.status(200).json({
        success: true,
        data: order,
      });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  static async verifyPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const { orderId, paymentId, signature, idempotencyKey } = req.body;

      const result = await PaymentsService.verifyPayment({
        userId,
        orderId,
        paymentId,
        signature,
        idempotencyKey,
      });

      res.status(200).json({
        success: true,
        message: result.alreadyPaid ? 'Payment already verified' : 'Payment verified and wallet credited',
        data: result,
      });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  static async webhook(req: Request, res: Response): Promise<void> {
    try {
      const rawBody = (req as any).rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const result = await PaymentsService.handleWebhook({
        rawBody,
        headers: req.headers,
        parsedBody: req.body,
      });
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  static async getHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const role = req.user?.role;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const history = await PaymentsService.getPaymentHistory(userId, role, limit, offset);
      res.status(200).json({ success: true, data: history });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async refund(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const role = req.user?.role;
      const { paymentId, amount, reason, idempotencyKey } = req.body;

      if (!paymentId || !reason) {
        res.status(400).json({ success: false, error: 'Payment ID and reason are required' });
        return;
      }

      const result = await PaymentsService.processRefund({
        paymentId,
        amount,
        reason,
        processedBy: userId,
        idempotencyKey,
      });

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }
}
