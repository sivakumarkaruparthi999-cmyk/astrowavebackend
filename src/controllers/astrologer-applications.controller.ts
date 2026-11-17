import { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { StorageService } from '../services/storage.service.js';
import { hashPassword } from '../auth/jwt.js';
import { getSocketServer } from '../websocket/socket.server.js';

function generateApplicationId(): string {
  const year = new Date().getFullYear();
  const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
  return `AW-ASTRO-${year}-${randomHex}`;
}

export class AstrologerApplicationsController {
  /**
   * Public: Submit a new Astrologer / Vendor verification application
   */
  static async submitApplication(req: Request, res: Response): Promise<void> {
    try {
      const {
        fullName,
        phone,
        email,
        profilePhoto,
        displayName,
        skills,
        otherSkill,
        languages,
        otherLanguage,
        yearsOfExperience,
        bio,
        specializations,
        consultationExperience,
        location,
        introVideo,
        certificates,
        documents,
        isConfirmed,
        password,
      } = req.body;

      // 1. Validations
      if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
        res.status(400).json({ success: false, error: 'Full name is required' });
        return;
      }

      if (!phone || typeof phone !== 'string' || !phone.trim()) {
        res.status(400).json({ success: false, error: 'Valid mobile number is required' });
        return;
      }

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        res.status(400).json({ success: false, error: 'Valid email address is required' });
        return;
      }

      if (!profilePhoto || typeof profilePhoto !== 'string') {
        res.status(400).json({ success: false, error: 'Profile photo is required' });
        return;
      }

      if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
        res.status(400).json({ success: false, error: 'Display name in app is required' });
        return;
      }

      if (isConfirmed !== true && isConfirmed !== 'true') {
        res.status(400).json({
          success: false,
          error: 'You must confirm that the information provided is accurate and complete',
        });
        return;
      }

      const cleanPhone = phone.trim();
      const cleanEmail = email.trim().toLowerCase();
      const cleanFullName = fullName.trim();
      const cleanDisplayName = displayName.trim();

      // Normalize skills and languages to array
      const skillsArray: string[] = Array.isArray(skills)
        ? skills.filter(Boolean)
        : typeof skills === 'string'
        ? skills.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      const languagesArray: string[] = Array.isArray(languages)
        ? languages.filter(Boolean)
        : typeof languages === 'string'
        ? languages.split(',').map((l) => l.trim()).filter(Boolean)
        : [];

      // 2. Save profile photo securely to disk if base64
      let savedPhotoUrl = profilePhoto;
      if (profilePhoto.startsWith('data:image/')) {
        const extMatch = profilePhoto.match(/^data:image\/(\w+);base64,/);
        const ext = extMatch ? `.${extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]}` : '.jpg';
        const photoFilename = `astro_app_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        savedPhotoUrl = await StorageService.saveBase64File('avatars', photoFilename, profilePhoto);
      }

      // Save any certificates/documents if base64
      const savedCertificates: string[] = [];
      if (Array.isArray(certificates)) {
        for (let i = 0; i < certificates.length; i++) {
          const doc = certificates[i];
          if (typeof doc === 'string' && doc.startsWith('data:')) {
            const docName = `cert_${Date.now()}_${i}.pdf`;
            const docUrl = await StorageService.saveBase64File('documents', docName, doc);
            savedCertificates.push(docUrl);
          } else if (typeof doc === 'string') {
            savedCertificates.push(doc);
          }
        }
      }

      const savedDocuments: string[] = [];
      if (Array.isArray(documents)) {
        for (let i = 0; i < documents.length; i++) {
          const doc = documents[i];
          if (typeof doc === 'string' && doc.startsWith('data:')) {
            const docName = `doc_${Date.now()}_${i}.pdf`;
            const docUrl = await StorageService.saveBase64File('documents', docName, doc);
            savedDocuments.push(docUrl);
          } else if (typeof doc === 'string') {
            savedDocuments.push(doc);
          }
        }
      }

      // 3. User account link or provisioning (unapproved/pending)
      let existingUser = await queryPostgresSingle(
        'SELECT id, role, is_verified FROM users WHERE email = $1 OR phone = $2',
        [cleanEmail, cleanPhone]
      );

      let userId = existingUser?.id;

      if (!existingUser) {
        const rawPassword = password || `Astro@${crypto.randomBytes(4).toString('hex')}`;
        const passwordHash = await hashPassword(rawPassword);
        const newUser = await queryPostgresSingle(
          `INSERT INTO users (email, phone, password_hash, role, status, is_verified)
           VALUES ($1, $2, $3, 'astrologer', 'active', false)
           RETURNING id`,
          [cleanEmail, cleanPhone, passwordHash]
        );
        userId = newUser.id;

        // Initialize user profile
        await queryPostgres(
          `INSERT INTO profiles (id, full_name, avatar_url, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
          [userId, cleanFullName, savedPhotoUrl]
        );

        // Initialize unverified astrologer profile
        await queryPostgres(
          `INSERT INTO astrologer_profiles (id, display_name, bio, specializations, experience_years, languages, is_verified, verification_status, per_minute_rate, call_per_minute_rate, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, false, 'pending', 25.0, 25.0, NOW())
           ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, bio = EXCLUDED.bio, specializations = EXCLUDED.specializations, experience_years = EXCLUDED.experience_years, languages = EXCLUDED.languages, updated_at = NOW()`,
          [
            userId,
            cleanDisplayName,
            bio || '',
            skillsArray,
            Number(yearsOfExperience) || 0,
            languagesArray,
          ]
        );
      } else {
        // Update user profile photo & name if available
        await queryPostgres(
          `INSERT INTO profiles (id, full_name, avatar_url, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
          [userId, cleanFullName, savedPhotoUrl]
        );
      }

      // 4. Create unique Application ID & Insert Application Record
      const applicationId = generateApplicationId();

      const newApp = await queryPostgresSingle(
        `INSERT INTO astrologer_applications (
          application_id, user_id, full_name, phone, email, profile_photo, display_name,
          skills, other_skill, languages, other_language, years_of_experience,
          bio, specializations, consultation_experience, location, intro_video,
          certificates, documents, status, submitted_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17,
          $18, $19, 'SUBMITTED', NOW(), NOW()
        ) RETURNING *`,
        [
          applicationId,
          userId,
          cleanFullName,
          cleanPhone,
          cleanEmail,
          savedPhotoUrl,
          cleanDisplayName,
          skillsArray,
          otherSkill || null,
          languagesArray,
          otherLanguage || null,
          Number(yearsOfExperience) || 0,
          bio || '',
          specializations || skillsArray.join(', '),
          consultationExperience || null,
          location || null,
          introVideo || null,
          savedCertificates,
          savedDocuments,
        ]
      );

      // Log initial status
      await queryPostgres(
        `INSERT INTO astrologer_status_history (application_id, from_status, to_status, notes)
         VALUES ($1, NULL, 'SUBMITTED', 'Application submitted by astrologer candidate')`,
        [newApp.id]
      );

      // Notify all admin accounts & broadcast in real-time
      try {
        const notifBody = `${cleanDisplayName} (${cleanPhone}) has submitted an application for verification [${applicationId}].`;
        await queryPostgres(
          `INSERT INTO notifications (user_id, title, body, type, channel, data)
           SELECT id, 'New Astrologer Application', $1, 'astrologer_application', 'in_app', $2::jsonb
           FROM users
           WHERE role IN ('admin', 'super_admin')`,
          [
            notifBody,
            JSON.stringify({
              applicationId,
              candidateName: cleanDisplayName,
              candidatePhone: cleanPhone,
              link: '/astrologers/verification',
            }),
          ]
        );

        const io = getSocketServer();
        if (io) {
          io.emit('admin_notification', {
            id: `app_${newApp.id}`,
            title: 'New Astrologer Application',
            message: notifBody,
            type: 'astrologer_application',
            link: '/astrologers/verification',
            applicationId,
            createdAt: new Date().toISOString(),
          });
        }
      } catch (notifErr) {
        console.warn('[AstrologerApplications] Admin notification warning:', notifErr);
      }

      res.status(201).json({
        success: true,
        message: 'Application submitted successfully and is now under review',
        data: {
          id: newApp.id,
          applicationId: newApp.application_id,
          status: newApp.status,
          submittedAt: newApp.submitted_at,
          fullName: newApp.full_name,
          displayName: newApp.display_name,
          email: newApp.email,
          phone: newApp.phone,
        },
      });
    } catch (err: any) {
      console.error('[AstrologerApplications.submitApplication] Error:', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to submit application' });
    }
  }

  /**
   * Public: Check Application Status by Application ID
   */
  static async getApplicationStatus(req: Request, res: Response): Promise<void> {
    try {
      const { applicationId } = req.params;

      const app = await queryPostgresSingle(
        `SELECT id, application_id, full_name, display_name, status,
                submitted_at, reviewed_at, approved_at, rejected_at,
                rejection_reason
         FROM astrologer_applications
         WHERE application_id = $1`,
        [applicationId]
      );

      if (!app) {
        res.status(404).json({ success: false, error: 'Application not found with the given ID' });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          applicationId: app.application_id,
          fullName: app.full_name,
          displayName: app.display_name,
          status: app.status,
          submittedAt: app.submitted_at,
          reviewedAt: app.reviewed_at,
          approvedAt: app.approved_at,
          rejectedAt: app.rejected_at,
          rejectionReason: app.status === 'REJECTED' ? app.rejection_reason : undefined,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Admin: List applications with tab filters and pagination
   */
  static async listApplications(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { status = 'all', search, limit = '20', offset = '0' } = req.query;

      // Status conditions
      let statusCondition = '';
      const params: any[] = [];
      let paramIndex = 1;

      const normStatus = String(status).toUpperCase();
      if (normStatus === 'PENDING' || normStatus === 'SUBMITTED') {
        statusCondition = `AND (status = 'SUBMITTED')`;
      } else if (normStatus === 'UNDER_REVIEW') {
        statusCondition = `AND (status = 'UNDER_REVIEW')`;
      } else if (normStatus === 'APPROVED') {
        statusCondition = `AND (status = 'APPROVED')`;
      } else if (normStatus === 'REJECTED') {
        statusCondition = `AND (status = 'REJECTED')`;
      }

      let searchCondition = '';
      if (search && String(search).trim()) {
        params.push(`%${String(search).trim()}%`);
        searchCondition = `AND (
          application_id ILIKE $${paramIndex} OR
          full_name ILIKE $${paramIndex} OR
          display_name ILIKE $${paramIndex} OR
          email ILIKE $${paramIndex} OR
          phone ILIKE $${paramIndex}
        )`;
        paramIndex++;
      }

      // Fetch count per tab for header pills
      const countsResult = await queryPostgres(`
        SELECT
          COUNT(*) AS total_count,
          COUNT(*) FILTER (WHERE status = 'SUBMITTED') AS pending_count,
          COUNT(*) FILTER (WHERE status = 'UNDER_REVIEW') AS under_review_count,
          COUNT(*) FILTER (WHERE status = 'APPROVED') AS approved_count,
          COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected_count
        FROM astrologer_applications
      `);

      const counts = countsResult[0] || {
        total_count: 0,
        pending_count: 0,
        under_review_count: 0,
        approved_count: 0,
        rejected_count: 0,
      };

      params.push(Number(limit) || 20);
      const limitParam = `$${paramIndex++}`;
      params.push(Number(offset) || 0);
      const offsetParam = `$${paramIndex++}`;

      const query = `
        SELECT id, application_id, user_id, full_name, phone, email, profile_photo,
               display_name, skills, other_skill, languages, other_language,
               years_of_experience, bio, specializations, consultation_experience,
               location, intro_video, certificates, documents, status,
               rejection_reason, submitted_at, reviewed_at, approved_at, rejected_at,
               created_at, updated_at
        FROM astrologer_applications
        WHERE 1=1 ${statusCondition} ${searchCondition}
        ORDER BY created_at DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}
      `;

      const rows = await queryPostgres(query, params);

      res.status(200).json({
        success: true,
        data: rows || [],
        counts: {
          all: Number(counts.total_count || 0),
          pending: Number(counts.pending_count || 0),
          underReview: Number(counts.under_review_count || 0),
          approved: Number(counts.approved_count || 0),
          rejected: Number(counts.rejected_count || 0),
        },
      });
    } catch (err: any) {
      console.error('[AstrologerApplications.listApplications] Error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Admin: View application details
   */
  static async getApplicationDetails(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const app = await queryPostgresSingle(
        `SELECT a.*,
                u.status AS user_status,
                u.is_verified AS user_is_verified,
                ap.per_minute_rate,
                ap.call_per_minute_rate,
                ap.is_muhurat_eligible,
                ap.is_chat_enabled,
                ap.is_call_enabled,
                ap.rating,
                ap.total_consultations
         FROM astrologer_applications a
         LEFT JOIN users u ON a.user_id = u.id
         LEFT JOIN astrologer_profiles ap ON a.user_id = ap.id
         WHERE a.id::text = $1 OR a.application_id = $1`,
        [id]
      );

      if (!app) {
        res.status(404).json({ success: false, error: 'Application not found' });
        return;
      }

      const history = await queryPostgres(
        `SELECT h.*, u.email AS changed_by_email
         FROM astrologer_status_history h
         LEFT JOIN users u ON h.changed_by = u.id
         WHERE h.application_id = $1
         ORDER BY h.created_at DESC`,
        [app.id]
      );

      res.status(200).json({
        success: true,
        data: {
          ...app,
          history: history || [],
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Admin: Approve Application
   */
  static async approveApplication(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const adminId = req.user?.userId;
      const { chatRate, callRate, isMuhuratEligible, isChatEnabled, isCallEnabled, notes } = req.body;

      const app = await queryPostgresSingle(
        'SELECT * FROM astrologer_applications WHERE id::text = $1 OR application_id = $1',
        [id]
      );

      if (!app) {
        res.status(404).json({ success: false, error: 'Application not found' });
        return;
      }

      const prevStatus = app.status;

      // 1. Update application status
      const updatedApp = await queryPostgresSingle(
        `UPDATE astrologer_applications
         SET status = 'APPROVED',
             approved_at = NOW(),
             reviewed_at = COALESCE(reviewed_at, NOW()),
             reviewed_by = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [adminId, app.id]
      );

      // 2. Log status history
      await queryPostgres(
        `INSERT INTO astrologer_status_history (application_id, from_status, to_status, changed_by, notes)
         VALUES ($1, $2, 'APPROVED', $3, $4)`,
        [app.id, prevStatus, adminId, notes || 'Application approved by administrator']
      );

      // 3. Activate user account
      let userId = app.user_id;
      if (!userId) {
        let u = await queryPostgresSingle('SELECT id FROM users WHERE email = $1 OR phone = $2', [app.email, app.phone]);
        if (u) {
          userId = u.id;
          await queryPostgres('UPDATE astrologer_applications SET user_id = $1 WHERE id = $2', [userId, app.id]);
        }
      }

      if (userId) {
        await queryPostgres(
          `UPDATE users
           SET role = 'astrologer',
               status = 'active',
               is_verified = true,
               updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );

        // Update profiles table
        await queryPostgres(
          `INSERT INTO profiles (id, full_name, avatar_url, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
          [userId, app.full_name, app.profile_photo]
        );

        const chatPrice = chatRate !== undefined && chatRate !== '' ? Number(chatRate) : 25.0;
        const callPrice = callRate !== undefined && callRate !== '' ? Number(callRate) : 25.0;
        const muhuratBool = isMuhuratEligible !== undefined ? Boolean(isMuhuratEligible) : true;
        const chatBool = isChatEnabled !== undefined ? Boolean(isChatEnabled) : true;
        const callBool = isCallEnabled !== undefined ? Boolean(isCallEnabled) : true;

        // Upsert astrologer profile
        await queryPostgres(
          `INSERT INTO astrologer_profiles (
            id, display_name, bio, specializations, experience_years, languages,
            per_minute_rate, call_per_minute_rate, is_muhurat_eligible,
            is_chat_enabled, is_call_enabled, is_verified, verification_status,
            is_online, is_busy, rating, total_reviews, total_consultations, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9,
            $10, $11, true, 'approved',
            false, false, 5.0, 0, 0, NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            bio = EXCLUDED.bio,
            specializations = EXCLUDED.specializations,
            experience_years = EXCLUDED.experience_years,
            languages = EXCLUDED.languages,
            per_minute_rate = COALESCE($7, astrologer_profiles.per_minute_rate),
            call_per_minute_rate = COALESCE($8, astrologer_profiles.call_per_minute_rate),
            is_muhurat_eligible = COALESCE($9, astrologer_profiles.is_muhurat_eligible),
            is_chat_enabled = COALESCE($10, astrologer_profiles.is_chat_enabled),
            is_call_enabled = COALESCE($11, astrologer_profiles.is_call_enabled),
            is_verified = true,
            verification_status = 'approved',
            updated_at = NOW()`,
          [
            userId,
            app.display_name,
            app.bio,
            Array.isArray(app.skills) && app.skills.length > 0 ? app.skills : (app.specializations ? app.specializations.split(',').map((s: string) => s.trim()) : ['Vedic Astrology']),
            Number(app.years_of_experience) || 0,
            Array.isArray(app.languages) && app.languages.length > 0 ? app.languages : ['Telugu', 'English'],
            chatPrice,
            callPrice,
            muhuratBool,
            chatBool,
            callBool,
          ]
        );
      }

      // Audit log
      await queryPostgres(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'admin_approve_astrologer_application', 'astrologer_application', $2, $3)`,
        [adminId, app.id, JSON.stringify({ applicationId: app.application_id, userId, approvedAt: new Date() })]
      );

      res.status(200).json({
        success: true,
        message: 'Astrologer application approved successfully and profile activated on AstroWave',
        data: updatedApp,
      });
    } catch (err: any) {
      console.error('[AstrologerApplications.approveApplication] Error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Admin: Reject Application
   */
  static async rejectApplication(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const adminId = req.user?.userId;
      const { reason } = req.body;

      if (!reason || !reason.trim()) {
        res.status(400).json({ success: false, error: 'Reason for rejection is required' });
        return;
      }

      const app = await queryPostgresSingle(
        'SELECT * FROM astrologer_applications WHERE id::text = $1 OR application_id = $1',
        [id]
      );

      if (!app) {
        res.status(404).json({ success: false, error: 'Application not found' });
        return;
      }

      const prevStatus = app.status;

      const updatedApp = await queryPostgresSingle(
        `UPDATE astrologer_applications
         SET status = 'REJECTED',
             rejection_reason = $1,
             rejected_at = NOW(),
             reviewed_at = COALESCE(reviewed_at, NOW()),
             reviewed_by = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [reason.trim(), adminId, app.id]
      );

      await queryPostgres(
        `INSERT INTO astrologer_status_history (application_id, from_status, to_status, changed_by, notes)
         VALUES ($1, $2, 'REJECTED', $3, $4)`,
        [app.id, prevStatus, adminId, reason.trim()]
      );

      // If user exists, ensure they are not verified
      if (app.user_id) {
        await queryPostgres('UPDATE users SET is_verified = false, updated_at = NOW() WHERE id = $1', [app.user_id]);
        await queryPostgres(
          `UPDATE astrologer_profiles
           SET is_verified = false, verification_status = 'rejected', updated_at = NOW()
           WHERE id = $1`,
          [app.user_id]
        );
      }

      // Audit log
      await queryPostgres(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'admin_reject_astrologer_application', 'astrologer_application', $2, $3)`,
        [adminId, app.id, JSON.stringify({ applicationId: app.application_id, reason })]
      );

      res.status(200).json({
        success: true,
        message: 'Application rejected',
        data: updatedApp,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Admin: Mark as Under Review
   */
  static async markUnderReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const adminId = req.user?.userId;
      const { notes } = req.body;

      const app = await queryPostgresSingle(
        'SELECT * FROM astrologer_applications WHERE id::text = $1 OR application_id = $1',
        [id]
      );

      if (!app) {
        res.status(404).json({ success: false, error: 'Application not found' });
        return;
      }

      const prevStatus = app.status;

      const updatedApp = await queryPostgresSingle(
        `UPDATE astrologer_applications
         SET status = 'UNDER_REVIEW',
             reviewed_at = NOW(),
             reviewed_by = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [adminId, app.id]
      );

      await queryPostgres(
        `INSERT INTO astrologer_status_history (application_id, from_status, to_status, changed_by, notes)
         VALUES ($1, $2, 'UNDER_REVIEW', $3, $4)`,
        [app.id, prevStatus, adminId, notes || 'Review initiated by verification team']
      );

      res.status(200).json({
        success: true,
        message: 'Application status changed to Under Review',
        data: updatedApp,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Admin: Edit Approved Astrologer / Application Profile Information
   */
  static async updateApplication(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const adminId = req.user?.userId;
      const {
        displayName,
        bio,
        skills,
        languages,
        yearsOfExperience,
        specializations,
        location,
        chatRate,
        callRate,
        isMuhuratEligible,
        isChatEnabled,
        isCallEnabled,
        profilePhoto,
      } = req.body;

      const app = await queryPostgresSingle(
        'SELECT * FROM astrologer_applications WHERE id::text = $1 OR application_id = $1',
        [id]
      );

      if (!app) {
        res.status(404).json({ success: false, error: 'Application not found' });
        return;
      }

      // Handle photo update if base64
      let savedPhotoUrl = app.profile_photo;
      if (profilePhoto && profilePhoto.startsWith('data:image/')) {
        const photoFilename = `astro_app_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
        savedPhotoUrl = await StorageService.saveBase64File('avatars', photoFilename, profilePhoto);
      } else if (profilePhoto && typeof profilePhoto === 'string') {
        savedPhotoUrl = profilePhoto;
      }

      const skillsArray = skills ? (Array.isArray(skills) ? skills : [skills]) : app.skills;
      const languagesArray = languages ? (Array.isArray(languages) ? languages : [languages]) : app.languages;

      const updatedApp = await queryPostgresSingle(
        `UPDATE astrologer_applications
         SET display_name = COALESCE($1, display_name),
             bio = COALESCE($2, bio),
             skills = COALESCE($3, skills),
             languages = COALESCE($4, languages),
             years_of_experience = COALESCE($5, years_of_experience),
             specializations = COALESCE($6, specializations),
             location = COALESCE($7, location),
             profile_photo = COALESCE($8, profile_photo),
             updated_at = NOW()
         WHERE id = $9
         RETURNING *`,
        [
          displayName,
          bio,
          skillsArray,
          languagesArray,
          yearsOfExperience !== undefined ? Number(yearsOfExperience) : null,
          specializations,
          location,
          savedPhotoUrl,
          app.id,
        ]
      );

      // If user profile is linked, sync public astrologer profile
      if (app.user_id) {
        await queryPostgres(
          `UPDATE astrologer_profiles
           SET display_name = COALESCE($1, display_name),
               bio = COALESCE($2, bio),
               specializations = COALESCE($3, specializations),
               experience_years = COALESCE($4, experience_years),
               languages = COALESCE($5, languages),
               per_minute_rate = COALESCE($6, per_minute_rate),
               call_per_minute_rate = COALESCE($7, call_per_minute_rate),
               is_muhurat_eligible = COALESCE($8, is_muhurat_eligible),
               is_chat_enabled = COALESCE($9, is_chat_enabled),
               is_call_enabled = COALESCE($10, is_call_enabled),
               updated_at = NOW()
           WHERE id = $11`,
          [
            displayName,
            bio,
            specializations || skillsArray.join(', '),
            yearsOfExperience !== undefined ? Number(yearsOfExperience) : null,
            languagesArray,
            chatRate !== undefined && chatRate !== '' ? Number(chatRate) : null,
            callRate !== undefined && callRate !== '' ? Number(callRate) : null,
            isMuhuratEligible !== undefined ? Boolean(isMuhuratEligible) : null,
            isChatEnabled !== undefined ? Boolean(isChatEnabled) : null,
            isCallEnabled !== undefined ? Boolean(isCallEnabled) : null,
            app.user_id,
          ]
        );

        if (savedPhotoUrl) {
          await queryPostgres('UPDATE profiles SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [
            savedPhotoUrl,
            app.user_id,
          ]);
        }
      }

      // Audit log
      await queryPostgres(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'admin_edit_astrologer_profile', 'astrologer_application', $2, $3)`,
        [adminId, app.id, JSON.stringify({ applicationId: app.application_id, updatedFields: req.body })]
      );

      res.status(200).json({
        success: true,
        message: 'Astrologer profile updated successfully',
        data: updatedApp,
      });
    } catch (err: any) {
      console.error('[AstrologerApplications.updateApplication] Error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
}
