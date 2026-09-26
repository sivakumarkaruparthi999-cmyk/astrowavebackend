import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { CallsService } from '../services/calls.service.js';
import { queryPostgresSingle } from '../config/db.js';

export class CallsController {
  static async getCallSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { consultationId } = req.params;
      const callerId = req.user?.userId;
      const callerRole = req.user?.role?.toLowerCase();

      if (!callerId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Verify caller is an authorized participant or admin
      const consultation = await queryPostgresSingle(
        'SELECT user_id, astrologer_id FROM consultations WHERE id = $1',
        [consultationId]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found' });
        return;
      }

      const isParticipant = consultation.user_id === callerId || consultation.astrologer_id === callerId;
      const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';

      if (!isParticipant && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to view this call session' });
        return;
      }

      const session = await CallsService.getCallSession(consultationId);
      if (!session) {
        res.status(404).json({ success: false, error: 'Call session not found' });
        return;
      }
      res.status(200).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async logCallSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const userRole = req.user?.role?.toLowerCase();
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const { consultationId, astrologerId, type, status, durationSeconds, event, metadata } = req.body;

      if (!consultationId || !astrologerId) {
        res.status(400).json({ success: false, error: 'consultationId and astrologerId are required' });
        return;
      }

      // Verify caller belongs to consultation
      const consultation = await queryPostgresSingle(
        'SELECT user_id, astrologer_id FROM consultations WHERE id = $1',
        [consultationId]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found' });
        return;
      }

      const isParticipant = consultation.user_id === userId || consultation.astrologer_id === userId;
      const isAdmin = userRole === 'admin' || userRole === 'super_admin';

      if (!isParticipant && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to log sessions for this consultation' });
        return;
      }

      const session = await CallsService.logCallSession({
        consultationId,
        userId,
        astrologerId,
        type,
        status,
        durationSeconds,
        event,
        metadata,
      });

      res.status(200).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getVideoSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { consultationId } = req.params;
      const callerId = req.user?.userId;
      const callerRole = req.user?.role?.toLowerCase();

      if (!callerId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const consultation = await queryPostgresSingle(
        'SELECT user_id, astrologer_id FROM consultations WHERE id = $1',
        [consultationId]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found' });
        return;
      }

      const isParticipant = consultation.user_id === callerId || consultation.astrologer_id === callerId;
      const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';

      if (!isParticipant && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to view this video session' });
        return;
      }

      const session = await CallsService.getVideoSession(consultationId);
      if (!session) {
        res.status(404).json({ success: false, error: 'Video call session not found' });
        return;
      }
      res.status(200).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async logVideoSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const callerId = req.user?.userId;
      const callerRole = req.user?.role?.toLowerCase();
      if (!callerId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { consultationId, sessionId, webrtcRoomId, status, qualityMetrics, recordingUrl, event } = req.body;

      if (!consultationId || !sessionId || !webrtcRoomId) {
        res.status(400).json({ success: false, error: 'consultationId, sessionId, and webrtcRoomId are required' });
        return;
      }

      // Verify caller is a participant in this consultation or admin
      const consultation = await queryPostgresSingle(
        'SELECT user_id, astrologer_id FROM consultations WHERE id = $1',
        [consultationId]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found' });
        return;
      }

      const isParticipant = consultation.user_id === callerId || consultation.astrologer_id === callerId;
      const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';

      if (!isParticipant && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to log video sessions for this consultation' });
        return;
      }

      const session = await CallsService.logVideoSession({
        consultationId,
        sessionId,
        webrtcRoomId,
        status,
        qualityMetrics,
        recordingUrl,
        event,
      });

      res.status(200).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async getIceServers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
      ];

      const turnUrl = process.env.TURN_URL || process.env.WEBRTC_TURN_SERVER;
      if (turnUrl) {
        const server: { urls: string; username?: string; credential?: string } = {
          urls: turnUrl
        };
        const username = process.env.TURN_USERNAME || process.env.WEBRTC_TURN_USER;
        const credential = process.env.TURN_CREDENTIAL || process.env.WEBRTC_TURN_PASS;
        if (username) server.username = username;
        if (credential) server.credential = credential;
        iceServers.push(server);
      }

      res.status(200).json({
        success: true,
        data: { iceServers }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
