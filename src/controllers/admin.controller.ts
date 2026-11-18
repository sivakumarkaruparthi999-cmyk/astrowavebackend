import { Response } from 'express';
import { pgPool, queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { disconnectUserSockets, getSocketServer } from '../websocket/socket.server.js';

export class AdminController {
  static async getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const totalUsers = await queryPostgresSingle("SELECT COUNT(*) AS count FROM users WHERE role = 'customer'");
      const totalAstrologers = await queryPostgresSingle("SELECT COUNT(*) AS count FROM users WHERE role = 'astrologer'");
      const activeConsultations = await queryPostgresSingle("SELECT COUNT(*) AS count FROM consultations WHERE state IN ('REQUESTED', 'ACCEPTED', 'ACTIVE')");
      const totalRevenue = await queryPostgresSingle("SELECT COALESCE(SUM(amount), 0) AS revenue FROM payments WHERE status = 'paid'");
      const totalCommissions = await queryPostgresSingle("SELECT COALESCE(SUM(platform_fee), 0) AS fees FROM commissions");
      const recentUsers = await queryPostgres(`
        SELECT u.id, u.email, u.phone, u.role, u.status, u.created_at, p.full_name, p.avatar_url
        FROM users u
        LEFT JOIN profiles p ON u.id = p.id
        ORDER BY u.created_at DESC
        LIMIT 8
      `);
      const recentConsultations = await queryPostgres(`
        SELECT c.*, cp.full_name AS customer_name, ap.display_name AS astrologer_name
        FROM consultations c
        LEFT JOIN profiles cp ON c.user_id = cp.id
        LEFT JOIN astrologer_profiles ap ON c.astrologer_id = ap.id
        ORDER BY c.created_at DESC
        LIMIT 8
      `);

      res.status(200).json({
        success: true,
        data: {
          totalUsers: Number(totalUsers?.count || 0),
          totalAstrologers: Number(totalAstrologers?.count || 0),
          activeConsultations: Number(activeConsultations?.count || 0),
          totalRevenue: Number(totalRevenue?.revenue || 0),
          platformEarnings: Number(totalCommissions?.fees || 0),
          recentUsers: recentUsers || [],
          recentConsultations: recentConsultations || [],
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { role, status, search, limit = 100 } = req.query;
      let sql = `
        SELECT u.id, u.email, u.phone, u.role, u.status, u.is_verified, u.created_at,
               p.full_name, p.avatar_url, p.gender, p.bio,
               w.balance AS wallet_balance
        FROM users u
        LEFT JOIN profiles p ON u.id = p.id
        LEFT JOIN wallets w ON u.id = w.user_id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (role) {
        params.push(role);
        sql += ` AND u.role = $${params.length}`;
      }
      if (status) {
        params.push(status);
        sql += ` AND u.status = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        sql += ` AND (p.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`;
      }

      const safeLimit = Math.min(Math.max(1, parseInt(limit as string, 10) || 50), 100);
      const safeOffset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

      sql += ` ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(safeLimit, safeOffset);

      const users = await queryPostgres(sql, params);
      res.status(200).json({ success: true, data: users || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async updateUserStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const callerRole = req.user?.role;
      const { id } = req.params;
      const { status, role } = req.body;

      // Check existing user role
      const targetUser = await queryPostgresSingle('SELECT id, role FROM users WHERE id = $1', [id]);
      if (!targetUser) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      // Vertical privilege escalation defense: only super_admin can modify super_admin or assign admin/super_admin roles
      if (targetUser.role === 'super_admin' && callerRole !== 'super_admin') {
        res.status(403).json({ success: false, error: 'Only super_admin can modify super_admin accounts' });
        return;
      }

      if (role && (role === 'super_admin' || role === 'admin') && callerRole !== 'super_admin') {
        res.status(403).json({ success: false, error: 'Only super_admin can assign administrative roles' });
        return;
      }

      await queryPostgres(
        `UPDATE users
         SET status = COALESCE($1, status),
             role = COALESCE($2, role),
             updated_at = NOW()
         WHERE id = $3`,
        [status || null, role || null, id]
      );

      // Cascading session invalidation: if user is blocked or suspended, immediately revoke refresh tokens & disconnect active sockets
      if (status === 'blocked' || status === 'suspended') {
        await queryPostgres(
          `UPDATE refresh_tokens
           SET revoked = true, revoked_at = NOW()
           WHERE user_id = $1 AND revoked = false`,
          [id]
        );
        disconnectUserSockets(id);
      }

      const updated = await queryPostgresSingle('SELECT id, email, phone, role, status FROM users WHERE id = $1', [id]);

      // Audit log (sanitized, no sensitive credentials)
      await queryPostgres(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'admin_update_user', 'user', $2, $3)`,
        [req.user?.userId, id, JSON.stringify({ status, role, updatedByRole: callerRole })]
      );

      res.status(200).json({ success: true, message: 'User updated successfully', data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listAstrologers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const astrologers = await queryPostgres(`
        SELECT u.id, u.email, u.phone, u.status, ap.display_name, ap.experience_years,
               ap.hourly_rate, ap.per_minute_rate, ap.call_per_minute_rate, ap.is_muhurat_eligible,
               ap.is_chat_enabled, ap.is_call_enabled,
               ap.is_verified, ap.verification_status,
               ap.is_online, ap.is_busy, ap.rating, ap.total_reviews, ap.total_consultations,
               ap.languages, ap.specializations, p.avatar_url, ap.created_at,
               GREATEST(
                 COALESCE(pe.total_earned, 0),
                 COALESCE((SELECT SUM(c.astrologer_earnings) FROM consultations c WHERE c.astrologer_id = u.id AND c.state = 'ENDED'), 0)
               ) AS total_earnings,
               COALESCE(pe.available_balance, 0) AS available_balance,
               COALESCE(pe.withdrawn_amount, 0) AS withdrawn_amount,
               COALESCE(pe.pending_payout_amount, 0) AS pending_payout_amount,
               COALESCE((SELECT SUM(c.platform_fee) FROM consultations c WHERE c.astrologer_id = u.id AND c.state = 'ENDED'), 0) AS platform_commission,
               COALESCE((SELECT SUM(c.total_amount) FROM consultations c WHERE c.astrologer_id = u.id AND c.state = 'ENDED'), 0) AS gross_revenue
        FROM users u
        JOIN astrologer_profiles ap ON u.id = ap.id
        LEFT JOIN profiles p ON u.id = p.id
        LEFT JOIN provider_earnings pe ON u.id = pe.provider_id
        ORDER BY ap.is_verified ASC, ap.created_at DESC
      `);
      res.status(200).json({ success: true, data: astrologers || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getAstrologerEarnings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const earnings = await queryPostgresSingle(
        'SELECT * FROM provider_earnings WHERE provider_id = $1',
        [id]
      );
      const consults = await queryPostgres(
        `SELECT COALESCE(SUM(astrologer_earnings), 0) AS consult_earnings,
                COALESCE(SUM(platform_fee), 0) AS consult_platform_fee,
                COALESCE(SUM(total_amount), 0) AS consult_gross
         FROM consultations
         WHERE astrologer_id = $1 AND state = 'ENDED'`,
        [id]
      );
      const totalEarned = Math.max(
        Number(earnings?.total_earned || 0),
        Number(consults?.[0]?.consult_earnings || 0)
      );

      res.status(200).json({
        success: true,
        data: {
          total_earnings: totalEarned,
          available_balance: Number(earnings?.available_balance || totalEarned),
          withdrawn_amount: Number(earnings?.withdrawn_amount || 0),
          pending_payout_amount: Number(earnings?.pending_payout_amount || 0),
          platform_commission: Number(consults?.[0]?.consult_platform_fee || 0),
          gross_revenue: Number(consults?.[0]?.consult_gross || 0),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async markPayoutDone(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const adminId = req.user?.userId;
      const { amount, bankReference, notes } = req.body;

      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');

        // Check or create provider_earnings
        const earningsRes = await client.query(
          'SELECT * FROM provider_earnings WHERE provider_id = $1 FOR UPDATE',
          [id]
        );

        let currentEarnings = earningsRes.rows[0];
        if (!currentEarnings) {
          const consultsSum = await client.query(
            "SELECT COALESCE(SUM(astrologer_earnings), 0) AS total FROM consultations WHERE astrologer_id = $1 AND state = 'ENDED'",
            [id]
          );
          const earned = Number(consultsSum.rows[0]?.total || 0);
          const insertRes = await client.query(
            `INSERT INTO provider_earnings (provider_id, total_earned, available_balance, withdrawn_amount, pending_payout_amount)
             VALUES ($1, $2, $2, 0, 0)
             RETURNING *`,
            [id, earned]
          );
          currentEarnings = insertRes.rows[0];
        }

        const currentAvailable = Number(currentEarnings.available_balance || 0);
        const payoutAmount = amount && Number(amount) > 0 ? Number(amount) : currentAvailable;

        if (payoutAmount <= 0) {
          await client.query('ROLLBACK');
          res.status(400).json({ success: false, error: 'No balance available to payout' });
          return;
        }

        const actualDeduct = Math.min(payoutAmount, currentAvailable);

        const updateRes = await client.query(
          `UPDATE provider_earnings
           SET available_balance = GREATEST(0, available_balance - $1),
               withdrawn_amount = withdrawn_amount + $1,
               updated_at = NOW()
           WHERE provider_id = $2
           RETURNING *`,
          [actualDeduct, id]
        );

        // Record in payout_requests
        await client.query(
          `INSERT INTO payout_requests (provider_id, amount, status, notes, bank_reference, processed_at)
           VALUES ($1, $2, 'COMPLETED', $3, $4, NOW())`,
          [id, actualDeduct, notes || 'Admin marked payout as done', bankReference || `ADMIN_PAYOUT_${Date.now()}`]
        );

        // Audit log
        await client.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
           VALUES ($1, 'admin_payout_done', 'provider_earnings', $2, $3)`,
          [adminId, id, JSON.stringify({ amount: actualDeduct, bankReference, previousBalance: currentAvailable })]
        );

        await client.query('COMMIT');

        res.status(200).json({
          success: true,
          message: `Payout of ₹${actualDeduct.toFixed(2)} marked as done successfully`,
          data: updateRes.rows[0],
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

  static async verifyAstrologer(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const {
        isVerified,
        status = 'approved',
        chatRate,
        callRate,
        perMinuteRate,
        isMuhuratEligible,
        isChatEnabled,
        isCallEnabled,
      } = req.body;
      const verifiedBool = isVerified ?? (status === 'approved');

      const chatPrice = chatRate !== undefined && chatRate !== null && chatRate !== '' ? Number(chatRate) : (perMinuteRate !== undefined && perMinuteRate !== null && perMinuteRate !== '' ? Number(perMinuteRate) : null);
      const callPrice = callRate !== undefined && callRate !== null && callRate !== '' ? Number(callRate) : null;
      const muhuratBool = isMuhuratEligible !== undefined ? Boolean(isMuhuratEligible) : null;
      const chatBool = isChatEnabled !== undefined ? Boolean(isChatEnabled) : null;
      const callBool = isCallEnabled !== undefined ? Boolean(isCallEnabled) : null;

      await queryPostgres(
        `UPDATE astrologer_profiles
         SET is_verified = $1,
             verification_status = $2,
             per_minute_rate = COALESCE($4, per_minute_rate),
             call_per_minute_rate = COALESCE($5, call_per_minute_rate),
             is_muhurat_eligible = COALESCE($6, is_muhurat_eligible),
             is_chat_enabled = COALESCE($7, is_chat_enabled),
             is_call_enabled = COALESCE($8, is_call_enabled),
             updated_at = NOW()
         WHERE id = $3`,
        [verifiedBool, status, id, chatPrice, callPrice, muhuratBool, chatBool, callBool]
      );

      await queryPostgres(
        `UPDATE users
         SET is_verified = $1, updated_at = NOW()
         WHERE id = $2`,
        [verifiedBool, id]
      );

      // Audit log
      await queryPostgres(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'admin_verify_astrologer', 'astrologer_profile', $2, $3)`,
        [req.user?.userId, id, JSON.stringify({ isVerified: verifiedBool, status, chatPrice, callPrice, isMuhuratEligible: muhuratBool, isChatEnabled: chatBool, isCallEnabled: callBool })]
      );

      // If approved or verified, send notification to the astrologer
      if (verifiedBool) {
        try {
          const notifTitle = 'Profile Verified! 🎉';
          const notifBody = 'Congratulations! Your AstroWave Astrologer profile has been verified by Admin. You are now active and visible to seekers.';
          await queryPostgres(
            `INSERT INTO notifications (user_id, title, body, type, channel, data)
             VALUES ($1, $2, $3, 'astrologer_approved', 'in_app', $4)`,
            [id, notifTitle, notifBody, JSON.stringify({ verifiedAt: new Date().toISOString(), link: '/profile' })]
          );

          const io = getSocketServer();
          if (io) {
            const notifPayload = {
              id: `verif_${id}_${Date.now()}`,
              userId: id,
              title: notifTitle,
              message: notifBody,
              body: notifBody,
              type: 'astrologer_approved',
              link: '/profile',
              verifiedAt: new Date().toISOString(),
            };
            io.to(`user_${id}`).emit('notification', notifPayload);
            io.to(`user_${id}`).emit('astrologer_approved', notifPayload);
            io.emit('astrologer_status_changed', { userId: id, status: 'APPROVED', isVerified: true });
          }
        } catch (notifErr) {
          console.warn('[AdminController] Failed to dispatch astrologer verification notification:', notifErr);
        }
      }

      res.status(200).json({ success: true, message: 'Astrologer verification and rate settings updated' });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async listAuditLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const logs = await queryPostgres(
        `SELECT a.*, u.email AS user_email, u.role AS user_role
         FROM audit_logs a
         LEFT JOIN users u ON a.user_id = u.id
         ORDER BY a.created_at DESC
         LIMIT 100`
      );
      res.status(200).json({ success: true, data: logs || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async broadcastNotification(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { title, body, targetRole = 'customer' } = req.body;

      if (!title || !body) {
        res.status(400).json({ success: false, error: 'Title and body are required' });
        return;
      }

      await queryPostgres(
        `INSERT INTO notifications (user_id, title, body, type)
         SELECT id, $1, $2, 'admin_broadcast'
         FROM users
         WHERE role::text = $3 OR $3 = 'all'`,
        [title, body, targetRole]
      );

      res.status(200).json({ success: true, message: 'Broadcast notification sent' });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getAdminNotifications(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // 1. New & Pending Astrologer Verification Applications (Primary Priority)
      const pendingApplications = await queryPostgres(`
        SELECT a.id, a.application_id, a.full_name, a.display_name, a.phone, a.email, a.status, a.submitted_at
        FROM astrologer_applications a
        WHERE a.status IN ('SUBMITTED', 'UNDER_REVIEW')
        ORDER BY a.submitted_at DESC
        LIMIT 15
      `).catch(() => []);

      const appNotifications = (pendingApplications || []).map((app: any) => ({
        id: `app-${app.id}`,
        title: 'New Astrologer Application',
        message: `${app.display_name} (${app.full_name}, ${app.phone}) applied for astrologer verification [${app.application_id}].`,
        type: 'astrologer_application',
        entityId: app.id,
        link: '/astrologers/verification',
        isRead: app.status === 'UNDER_REVIEW',
        createdAt: app.submitted_at,
      }));

      // 2. Active / Requested Consultations
      const recentConsultations = await queryPostgres(`
        SELECT c.id, c.type, c.state, c.created_at,
               p.full_name AS customer_name,
               ap.display_name AS astrologer_name
        FROM consultations c
        LEFT JOIN profiles p ON c.user_id = p.id
        LEFT JOIN astrologer_profiles ap ON c.astrologer_id = ap.id
        WHERE c.state IN ('REQUESTED', 'ACCEPTED', 'ACTIVE')
        ORDER BY c.created_at DESC
        LIMIT 10
      `).catch(() => []);

      const consultationNotifs = (recentConsultations || []).map((c: any) => ({
        id: `cons-${c.id}`,
        title: `Live Consultation: ${c.type.toUpperCase()}`,
        message: `${c.customer_name || 'Seeker'} connected with ${c.astrologer_name || 'Astrologer'}.`,
        type: 'consultation',
        link: '/consultations',
        isRead: false,
        createdAt: c.created_at,
      }));

      // 3. Customer Enquiries
      const recentEnquiries = await queryPostgres(`
        SELECT id, name, email, subject, message, created_at
        FROM contact_enquiries
        ORDER BY created_at DESC
        LIMIT 5
      `).catch(() => []);

      const enquiryNotifs = (recentEnquiries || []).map((e: any) => ({
        id: `enq-${e.id}`,
        title: 'New Customer Enquiry',
        message: `${e.name}: ${e.subject || (e.message ? e.message.substring(0, 80) : 'General query')}`,
        type: 'enquiry',
        link: '/enquiries',
        isRead: false,
        createdAt: e.created_at,
      }));

      // 4. Notifications table entries
      const systemNotifs = await queryPostgres(`
        SELECT n.id, n.title, n.body, n.type, n.is_read, n.created_at, n.data
        FROM notifications n
        WHERE n.type IN ('admin_broadcast', 'astrologer_application', 'kyc_pending', 'payout_request', 'system_alert')
           OR n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 25
      `, [req.user?.userId]).catch(() => []);

      const systemMapped = (systemNotifs || []).map((n: any) => {
        const link = n.data?.link || (n.type === 'astrologer_application' ? '/astrologers/verification' : n.type === 'kyc' ? '/astrologers' : '/dashboard');
        return {
          id: String(n.id),
          title: n.title,
          message: n.body,
          type: n.type,
          link,
          isRead: Boolean(n.is_read),
          createdAt: n.created_at,
        };
      });

      // Combine, deduplicate by ID, and sort by createdAt desc
      const combinedMap = new Map<string, any>();
      [...appNotifications, ...systemMapped, ...consultationNotifs, ...enquiryNotifs].forEach((item) => {
        if (!combinedMap.has(item.id)) {
          combinedMap.set(item.id, item);
        }
      });

      const allNotifications = Array.from(combinedMap.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      res.status(200).json({
        success: true,
        data: allNotifications,
        unreadCount: allNotifications.filter(n => !n.isRead).length,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
