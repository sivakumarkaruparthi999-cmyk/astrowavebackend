import { Request, Response } from 'express';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';

export class AstrologersController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const { search, specialization, language, isOnline } = req.query;

      let sql = `
        SELECT u.id, p.avatar_url, ap.display_name, ap.bio,
                ap.experience_years, ap.hourly_rate, ap.per_minute_rate,
                ap.is_verified, ap.verification_status, ap.is_online, ap.is_busy, ap.rating,
                ap.total_reviews, ap.total_consultations, ap.languages, ap.specializations
        FROM users u
        JOIN astrologer_profiles ap ON u.id = ap.id
        LEFT JOIN profiles p ON u.id = p.id
        WHERE u.role = 'astrologer' AND u.status = 'active' AND ap.is_verified = true
      `;
      const params: any[] = [];

      if (isOnline === 'true') {
        sql += ` AND ap.is_online = true`;
      }

      if (search) {
        params.push(`%${search}%`);
        sql += ` AND (ap.display_name ILIKE $${params.length} OR ap.bio ILIKE $${params.length})`;
      }

      if (specialization) {
        params.push(specialization);
        sql += ` AND $${params.length} = ANY(ap.specializations)`;
      }

      if (language) {
        params.push(language);
        sql += ` AND $${params.length} = ANY(ap.languages)`;
      }

      const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 50), 100);
      const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);
      sql += ` ORDER BY ap.is_online DESC, ap.rating DESC, ap.total_consultations DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const astrologers = await queryPostgres(sql, params);
      const formatted = (astrologers || []).map((a: any) => ({
        ...a,
        experience_years: Number(a.experience_years || 0),
        hourly_rate: Number(a.hourly_rate || 0),
        per_minute_rate: Number(a.per_minute_rate || 0),
        rating: Number(a.rating || 5.0),
        total_reviews: Number(a.total_reviews || 0),
        total_consultations: Number(a.total_consultations || 0),
        languages: Array.isArray(a.languages) ? a.languages : [],
        specializations: Array.isArray(a.specializations) ? a.specializations : [],
      }));
      res.status(200).json({ success: true, data: formatted });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const astrologer = await queryPostgresSingle(
        `SELECT u.id, p.avatar_url, ap.display_name, ap.bio,
                ap.experience_years, ap.hourly_rate, ap.per_minute_rate,
                ap.is_verified, ap.is_online, ap.is_busy, ap.rating,
                ap.total_reviews, ap.total_consultations, ap.languages, ap.specializations
         FROM users u
         JOIN astrologer_profiles ap ON u.id = ap.id
         LEFT JOIN profiles p ON u.id = p.id
         WHERE u.id = $1`,
        [id]
      );

      if (!astrologer) {
        res.status(404).json({ success: false, error: 'Astrologer not found' });
        return;
      }

      const reviews = await queryPostgres(
        `SELECT r.id, r.rating, r.comment, r.created_at,
                CASE WHEN r.is_anonymous THEN 'Anonymous' ELSE p.full_name END AS user_name,
                CASE WHEN r.is_anonymous THEN NULL ELSE p.avatar_url END AS user_avatar
         FROM reviews r
         JOIN profiles p ON r.user_id = p.id
         WHERE r.astrologer_id = $1
         ORDER BY r.created_at DESC LIMIT 20`,
        [id]
      );

      const availability = await queryPostgres(
        'SELECT * FROM astrologer_availability WHERE astrologer_id = $1 AND is_active = true ORDER BY day_of_week, start_time',
        [id]
      );

      res.status(200).json({
        success: true,
        data: {
          ...astrologer,
          experience_years: Number(astrologer.experience_years || 0),
          hourly_rate: Number(astrologer.hourly_rate || 0),
          per_minute_rate: Number(astrologer.per_minute_rate || 0),
          rating: Number(astrologer.rating || 5.0),
          total_reviews: Number(astrologer.total_reviews || 0),
          total_consultations: Number(astrologer.total_consultations || 0),
          languages: Array.isArray(astrologer.languages) ? astrologer.languages : [],
          specializations: Array.isArray(astrologer.specializations) ? astrologer.specializations : [],
          reviews: reviews || [],
          availability: availability || [],
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async updateStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const astrologerId = req.user?.userId;
      const { isOnline, isBusy, perMinuteRate, hourlyRate, languages, specializations, bio } = req.body;

      if (perMinuteRate !== undefined) {
        const rate = Number(perMinuteRate);
        if (isNaN(rate) || rate < 1 || rate > 1000) {
          res.status(400).json({ success: false, error: 'perMinuteRate must be a number between ₹1 and ₹1,000' });
          return;
        }
      }

      if (hourlyRate !== undefined) {
        const rate = Number(hourlyRate);
        if (isNaN(rate) || rate < 50 || rate > 60000) {
          res.status(400).json({ success: false, error: 'hourlyRate must be a number between ₹50 and ₹60,000' });
          return;
        }
      }

      if (languages !== undefined && (!Array.isArray(languages) || languages.some((l) => typeof l !== 'string' || !l.trim()))) {
        res.status(400).json({ success: false, error: 'languages must be an array of non-empty strings' });
        return;
      }

      if (specializations !== undefined && (!Array.isArray(specializations) || specializations.some((s) => typeof s !== 'string' || !s.trim()))) {
        res.status(400).json({ success: false, error: 'specializations must be an array of non-empty strings' });
        return;
      }

      await queryPostgres(
        `UPDATE astrologer_profiles
         SET is_online = COALESCE($1, is_online),
             is_busy = COALESCE($2, is_busy),
             per_minute_rate = COALESCE($3, per_minute_rate),
             hourly_rate = COALESCE($4, hourly_rate),
             languages = COALESCE($5, languages),
             specializations = COALESCE($6, specializations),
             bio = COALESCE($7, bio),
             updated_at = NOW()
         WHERE id = $8`,
        [
          isOnline,
          isBusy,
          perMinuteRate !== undefined ? Number(perMinuteRate) : null,
          hourlyRate !== undefined ? Number(hourlyRate) : null,
          languages !== undefined ? languages : null,
          specializations !== undefined ? specializations : null,
          bio,
          astrologerId,
        ]
      );

      const updated = await queryPostgresSingle('SELECT * FROM astrologer_profiles WHERE id = $1', [astrologerId]);
      res.status(200).json({ success: true, message: 'Status updated', data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getEarnings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const astrologerId = req.user?.userId;
      const earnings = await queryPostgresSingle(
        'SELECT * FROM provider_earnings WHERE provider_id = $1',
        [astrologerId]
      );

      const commissions = await queryPostgres(
        'SELECT * FROM commissions WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 50',
        [astrologerId]
      );

      const payoutRequests = await queryPostgres(
        'SELECT * FROM payout_requests WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 20',
        [astrologerId]
      );

      res.status(200).json({
        success: true,
        data: {
          earnings: earnings || {
            total_earned: 0,
            available_balance: 0,
            withdrawn_amount: 0,
            pending_payout_amount: 0,
          },
          commissions: commissions || [],
          payoutRequests: payoutRequests || [],
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async uploadDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const astrologerId = req.user?.userId;
      const { documentType, documentUrl } = req.body;

      if (!documentType || !documentUrl) {
        res.status(400).json({ success: false, error: 'Document type and URL are required' });
        return;
      }

      const doc = await queryPostgresSingle(
        `INSERT INTO astrologer_documents (astrologer_id, document_type, document_url, verification_status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING *`,
        [astrologerId, documentType, documentUrl]
      );

      res.status(201).json({ success: true, message: 'Document uploaded for verification', data: doc });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
