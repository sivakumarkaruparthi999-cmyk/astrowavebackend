import { Response } from 'express';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { AstrologyEngineService } from '../services/astrology.service.js';
import { WalletService } from '../services/wallet.service.js';

export class UsersController {
  static async updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { fullName, avatarUrl, dateOfBirth, timeOfBirth, placeOfBirth, gender, latitude, longitude, bio } = req.body;

      await queryPostgres(
        `UPDATE profiles
         SET full_name = COALESCE($1, full_name),
             avatar_url = COALESCE($2, avatar_url),
             date_of_birth = COALESCE($3, date_of_birth),
             time_of_birth = COALESCE($4, time_of_birth),
             place_of_birth = COALESCE($5, place_of_birth),
             gender = COALESCE($6, gender),
             latitude = COALESCE($7, latitude),
             longitude = COALESCE($8, longitude),
             bio = COALESCE($9, bio),
             updated_at = NOW()
         WHERE id = $10`,
        [fullName, avatarUrl, dateOfBirth, timeOfBirth, placeOfBirth, gender, latitude, longitude, bio, userId]
      );

      const updated = await queryPostgresSingle('SELECT * FROM profiles WHERE id = $1', [userId]);

      res.status(200).json({ success: true, message: 'Profile updated successfully', data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getWallet(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const wallet = await WalletService.getWallet(userId);
      res.status(200).json({
        success: true,
        data: wallet,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listSavedKundlis(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const kundlis = await queryPostgres(
        'SELECT * FROM user_kundli_profiles WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      res.status(200).json({ success: true, data: kundlis || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async saveKundli(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { name, gender, birthDate, birthTime, birthPlace, latitude, longitude, timezone = 'Asia/Kolkata', ayanamsha = 'LAHIRI' } = req.body;

      if (!name || !birthDate || !birthTime || !birthPlace || latitude === undefined || longitude === undefined) {
        res.status(400).json({ success: false, error: 'Missing required birth details' });
        return;
      }

      // Strict schema and bounds validation
      if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || isNaN(Date.parse(birthDate))) {
        res.status(400).json({ success: false, error: 'Invalid birthDate format (expected YYYY-MM-DD)' });
        return;
      }

      if (typeof birthTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(birthTime)) {
        res.status(400).json({ success: false, error: 'Invalid birthTime format (expected HH:mm or HH:mm:ss in 24-hour time)' });
        return;
      }

      const lat = Number(latitude);
      const lng = Number(longitude);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        res.status(400).json({ success: false, error: 'Invalid latitude (must be a valid number between -90 and 90)' });
        return;
      }
      if (isNaN(lng) || lng < -180 || lng > 180) {
        res.status(400).json({ success: false, error: 'Invalid longitude (must be a valid number between -180 and 180)' });
        return;
      }

      // Generate deterministic chart data
      const chartData = AstrologyEngineService.generateKundli({
        name,
        gender,
        birthDate,
        birthTime,
        birthPlace,
        latitude: lat,
        longitude: lng,
        timezone,
        ayanamsha,
      });

      const saved = await queryPostgresSingle(
        `INSERT INTO user_kundli_profiles (user_id, name, gender, birth_date, birth_time, birth_place, latitude, longitude, timezone, ayanamsha, chart_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [userId, name, gender, birthDate, birthTime, birthPlace, latitude, longitude, timezone, ayanamsha, JSON.stringify(chartData)]
      );

      res.status(201).json({ success: true, message: 'Kundli saved successfully', data: saved });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getNotifications(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const notifications = await queryPostgres(
        'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
        [userId]
      );
      res.status(200).json({ success: true, data: notifications || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async markNotificationRead(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { id } = req.params;
      if (id === 'all') {
        await queryPostgres('UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = $1', [userId]);
      } else {
        await queryPostgres('UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1 AND user_id = $2', [id, userId]);
      }
      res.status(200).json({ success: true, message: 'Notification marked as read' });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
