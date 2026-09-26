import { Request, Response } from 'express';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';

export class PoojaController {
  static async listServices(req: Request, res: Response): Promise<void> {
    try {
      const services = await queryPostgres(
        'SELECT * FROM pooja_services WHERE is_active = true ORDER BY name ASC'
      );
      res.status(200).json({ success: true, data: services || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getServiceBySlug(req: Request, res: Response): Promise<void> {
    try {
      const { slug } = req.params;
      const service = await queryPostgresSingle(
        'SELECT * FROM pooja_services WHERE slug = $1 OR id::text = $1',
        [slug]
      );
      if (!service) {
        res.status(404).json({ success: false, error: 'Pooja service not found' });
        return;
      }
      res.status(200).json({ success: true, data: service });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async bookPooja(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { poojaServiceId, bookingDate, bookingTime, address, city, state, pincode, gotra, nakshatra, specialInstructions } = req.body;

      if (!poojaServiceId || !bookingDate || !bookingTime) {
        res.status(400).json({ success: false, error: 'Missing required booking details' });
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate) || isNaN(Date.parse(bookingDate))) {
        res.status(400).json({ success: false, error: 'Invalid bookingDate format. Expected YYYY-MM-DD.' });
        return;
      }

      if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(bookingTime)) {
        res.status(400).json({ success: false, error: 'Invalid bookingTime format. Expected HH:MM or HH:MM:SS.' });
        return;
      }

      const service = await queryPostgresSingle('SELECT * FROM pooja_services WHERE id = $1', [poojaServiceId]);
      if (!service) {
        res.status(404).json({ success: false, error: 'Pooja service not found' });
        return;
      }

      const booking = await queryPostgresSingle(
        `INSERT INTO pooja_bookings (
           user_id, pooja_service_id, booking_date, booking_time,
           address, city, state, pincode, gotra, nakshatra, special_instructions,
           total_amount, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'REQUESTED')
         RETURNING *`,
        [
          userId,
          poojaServiceId,
          bookingDate,
          bookingTime,
          address || '',
          city || '',
          state || '',
          pincode || '',
          gotra || '',
          nakshatra || '',
          specialInstructions || '',
          service.price,
        ]
      );

      res.status(201).json({ success: true, message: 'Pooja booked successfully', data: booking });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listUserBookings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const bookings = await queryPostgres(
        `SELECT pb.*, ps.name AS service_name, ps.image_url AS service_image,
                pp.full_name AS pandit_name
         FROM pooja_bookings pb
         JOIN pooja_services ps ON pb.pooja_service_id = ps.id
         LEFT JOIN pandit_profiles pp ON pb.pandit_id = pp.id
         WHERE pb.user_id = $1
         ORDER BY pb.booking_date DESC`,
        [userId]
      );
      res.status(200).json({ success: true, data: bookings || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
