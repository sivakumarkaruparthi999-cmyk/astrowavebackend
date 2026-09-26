import { Response } from 'express';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getSocketServer } from '../websocket/socket.server.js';
import { BillingService } from '../services/billing.service.js';

export class ConsultationsController {
  static async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { astrologerId, type = 'chat' } = req.body;

      if (!astrologerId) {
        res.status(400).json({ success: false, error: 'Astrologer ID is required' });
        return;
      }

      // Invariant: Customer cannot initiate a consultation with themselves
      if (userId === astrologerId) {
        res.status(400).json({ success: false, error: 'Cannot initiate consultation with yourself' });
        return;
      }

      // Check astrologer rate & availability
      const astrologer = await queryPostgresSingle(
        'SELECT id, per_minute_rate, hourly_rate, is_online, is_busy FROM astrologer_profiles WHERE id = $1',
        [astrologerId]
      );

      if (!astrologer) {
        res.status(404).json({ success: false, error: 'Astrologer not found' });
        return;
      }

      const rawRate = Number(astrologer.per_minute_rate);
      const hourlyRate = Number(astrologer.hourly_rate);
      const ratePerMinute = rawRate > 0 ? rawRate : (hourlyRate > 0 ? Math.round((hourlyRate / 60) * 100) / 100 : 20.0);
      const minRequiredBalance = ratePerMinute * 1; // Minimum 1 min balance required to start

      // Check user wallet
      const wallet = await queryPostgresSingle('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
      const balance = wallet ? Number(wallet.balance) : 0;

      if (balance < minRequiredBalance) {
        res.status(400).json({
          success: false,
          error: `Insufficient wallet balance. Minimum ₹${minRequiredBalance.toFixed(2)} (1 minute) required. Current balance: ₹${balance.toFixed(2)}`,
        });
        return;
      }

      const consultation = await queryPostgresSingle(
        `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute)
         VALUES ($1, $2, $3, 'REQUESTED', $4)
         RETURNING *`,
        [userId, astrologerId, type, ratePerMinute]
      );

      // Customer profile for rich notification
      const userProfile = await queryPostgresSingle('SELECT full_name, avatar_url FROM profiles WHERE id = $1', [userId]);
      const customerName = userProfile?.full_name || 'Customer';

      // Create notification for astrologer in database
      await queryPostgres(
        `INSERT INTO notifications (user_id, title, body, type, data)
         VALUES ($1, 'New Consultation Request', $2, 'consultation', $3)`,
        [
          astrologerId,
          `${customerName} is requesting a ${type} consultation with you.`,
          JSON.stringify({ consultationId: consultation.id, customerName, type }),
        ]
      );

      // Emit realtime socket event ONLY to the targeted astrologer and customer
      const io = getSocketServer();
      if (io) {
        const socketPayload = {
          id: consultation.id,
          consultationId: consultation.id,
          userId: userId,
          customerName: customerName,
          astrologerId: astrologerId,
          type: type,
          status: 'REQUESTED',
          ratePerMinute: ratePerMinute,
          createdAt: consultation.created_at || new Date().toISOString(),
        };
        io.to(`user_${astrologerId}`).emit('consultation_requested', socketPayload);
        io.to(`user_${astrologerId}`).emit('incoming_consultation', socketPayload);
        io.to(`user_${userId}`).emit('consultation_requested', socketPayload);
      }

      res.status(201).json({
        success: true,
        message: 'Consultation requested successfully',
        data: consultation,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async accept(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const astrologerId = req.user?.userId;
      const { id } = req.params;

      const consultation = await queryPostgresSingle(
        `UPDATE consultations
         SET state = 'ACTIVE', start_time = COALESCE(start_time, NOW()), updated_at = NOW()
         WHERE id = $1 AND astrologer_id = $2 AND state IN ('REQUESTED', 'ACCEPTED')
         RETURNING *`,
        [id, astrologerId]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found or not in REQUESTED/ACCEPTED state' });
        return;
      }

      await queryPostgres('UPDATE astrologer_profiles SET is_busy = true WHERE id = $1', [astrologerId]);

      // Notify customer
      await queryPostgres(
        `INSERT INTO notifications (user_id, title, body, type, data)
         VALUES ($1, 'Consultation Accepted', 'The astrologer has accepted your consultation request.', 'consultation', $2)`,
        [consultation.user_id, JSON.stringify({ consultationId: consultation.id })]
      );

      const io = getSocketServer();
      if (io) {
        const activePayload = {
          consultationId: consultation.id,
          status: 'ACTIVE',
          startTime: consultation.start_time,
          ratePerMinute: Number(consultation.rate_per_minute),
        };
        io.to(`consultation_${consultation.id}`).emit('consultation_started', activePayload);
        io.to(`user_${consultation.user_id}`).emit('consultation_started', activePayload);
        io.to(`user_${astrologerId}`).emit('consultation_started', activePayload);
      }

      res.status(200).json({ success: true, message: 'Consultation accepted', data: consultation });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async start(req: AuthenticatedRequest, res: Response): Promise<void> {
    return ConsultationsController.accept(req, res);
  }

  static async end(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const callerUserId = req.user?.userId;
      const callerRole = req.user?.role;

      if (!callerUserId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const rawDuration = req.body.durationSeconds !== undefined 
        ? req.body.durationSeconds 
        : req.body.actual_duration_seconds;

      const durationSeconds = rawDuration !== undefined ? Number(rawDuration) : undefined;
      const idempotencyKey = req.body.idempotencyKey;

      const billing = await BillingService.endAndBillConsultation({
        consultationId: id,
        callerUserId,
        callerRole,
        durationSeconds,
        idempotencyKey,
      });

      const finalized = await queryPostgresSingle('SELECT * FROM consultations WHERE id = $1', [id]);

      res.status(200).json({
        success: true,
        message: 'Consultation ended and settled successfully',
        data: finalized,
        billing,
      });
    } catch (err: any) {
      if (err?.message && err.message.startsWith('Unauthorized')) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  static async getById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const callerId = req.user?.userId;
      const callerRole = req.user?.role?.toLowerCase();

      if (!callerId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const consultation = await queryPostgresSingle(
        `SELECT c.*,
                cp.full_name AS customer_name, cp.avatar_url AS customer_avatar,
                ap.display_name AS astrologer_name, app.avatar_url AS astrologer_avatar
         FROM consultations c
         LEFT JOIN profiles cp ON c.user_id = cp.id
         LEFT JOIN astrologer_profiles ap ON c.astrologer_id = ap.id
         LEFT JOIN profiles app ON c.astrologer_id = app.id
         WHERE c.id = $1`,
        [id]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found' });
        return;
      }

      // Object-Level Authorization: Caller must be the customer, the assigned astrologer, or an admin
      const isCustomer = consultation.user_id === callerId;
      const isAstrologer = consultation.astrologer_id === callerId;
      const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';

      if (!isCustomer && !isAstrologer && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to view this consultation' });
        return;
      }

      res.status(200).json({ success: true, data: consultation });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listUserHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const role = req.user?.role;

      let sql = `
        SELECT c.*,
               cp.full_name AS customer_name, cp.avatar_url AS customer_avatar,
               ap.display_name AS astrologer_name, app.avatar_url AS astrologer_avatar
        FROM consultations c
        LEFT JOIN profiles cp ON c.user_id = cp.id
        LEFT JOIN astrologer_profiles ap ON c.astrologer_id = ap.id
        LEFT JOIN profiles app ON c.astrologer_id = app.id
      `;

      if (role === 'astrologer') {
        sql += ` WHERE c.astrologer_id = $1 ORDER BY c.created_at DESC LIMIT 50`;
      } else {
        sql += ` WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 50`;
      }

      const list = await queryPostgres(sql, [userId]);
      res.status(200).json({ success: true, data: list || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
