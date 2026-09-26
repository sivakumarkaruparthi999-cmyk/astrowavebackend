import { Request, Response } from 'express';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { AstrologyEngineService } from '../services/astrology.service.js';

export class MuhuratController {
  static async calculate(req: Request, res: Response): Promise<void> {
    try {
      const { date, latitude = 28.6139, longitude = 77.2090 } = req.body;
      const dateStr = date || new Date().toISOString().split('T')[0];

      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)))) {
        res.status(400).json({ success: false, error: 'Invalid date format. Expected YYYY-MM-DD.' });
        return;
      }

      const latNum = Number(latitude);
      const lonNum = Number(longitude);
      if (isNaN(latNum) || latNum < -90 || latNum > 90 || isNaN(lonNum) || lonNum < -180 || lonNum > 180) {
        res.status(400).json({ success: false, error: 'Invalid coordinates. Latitude must be -90..90 and Longitude -180..180.' });
        return;
      }

      const result = AstrologyEngineService.calculateMuhurat(
        dateStr,
        latNum,
        lonNum
      );

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async createOrder(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { eventType, eventName, startDate, endDate, place, latitude, longitude, timezone, notes } = req.body;
      const fixedAmount = 499; // Authoritative pricing determined server-side

      if (!eventType || !eventName || !startDate || !endDate) {
        res.status(400).json({ success: false, error: 'Missing required event details' });
        return;
      }

      const order = await queryPostgresSingle(
        `INSERT INTO muhurat_orders (user_id, event_type, event_name, start_date, end_date, place, latitude, longitude, timezone, notes, amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
         RETURNING *`,
        [userId, eventType, eventName, startDate, endDate, place || '', latitude || 28.6139, longitude || 77.2090, timezone || 'Asia/Kolkata', notes || '', fixedAmount]
      );

      res.status(201).json({ success: true, message: 'Muhurat order placed', data: order });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listOrders(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const orders = await queryPostgres(
        'SELECT * FROM muhurat_orders WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      res.status(200).json({ success: true, data: orders || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
