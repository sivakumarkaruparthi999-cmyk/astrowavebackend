import mongoose from 'mongoose';
import { CallSession, ICallSession } from '../models/mongo/CallSession.js';
import { VideoCallSession, IVideoCallSession } from '../models/mongo/VideoCallSession.js';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';

export class CallsService {
  /**
   * Create or update voice/video call session in MongoDB
   */
  static async logCallSession(data: {
    consultationId: string;
    sessionId?: string;
    userId: string;
    astrologerId: string;
    type?: 'voice' | 'video';
    status?: 'initiating' | 'ringing' | 'accepted' | 'connecting' | 'connected' | 'ended' | 'missed' | 'rejected' | 'cancelled' | 'failed';
    durationSeconds?: number;
    event?: string;
    metadata?: Record<string, any>;
  }): Promise<ICallSession> {
    const {
      consultationId,
      sessionId,
      userId,
      astrologerId,
      type = 'voice',
      status = 'initiating',
      durationSeconds,
      event,
      metadata = {},
    } = data;

    if (mongoose.connection.readyState !== 1) {
      return {
        sessionId: sessionId || `cses_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        consultationId,
        userId,
        astrologerId,
        type,
        status,
        startedAt: new Date(),
        connectedAt: status === 'connected' ? new Date() : undefined,
        endedAt: status === 'ended' ? new Date() : undefined,
        durationSeconds: durationSeconds || 0,
        connectionEvents: [],
      } as unknown as ICallSession;
    }

    let session = sessionId
      ? await CallSession.findOne({ sessionId })
      : await CallSession.findOne({ consultationId }).sort({ createdAt: -1 });

    const connectionEvents: any[] = [];
    if (event) {
      connectionEvents.push({
        event,
        timestamp: new Date(),
        metadata,
      });
    }

    const now = new Date();

    if (!session) {
      session = await CallSession.create({
        sessionId: sessionId || `cses_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        consultationId,
        userId,
        astrologerId,
        type,
        status,
        startedAt: now,
        connectedAt: status === 'connected' ? now : undefined,
        endedAt: status === 'ended' ? now : undefined,
        durationSeconds: durationSeconds || 0,
        connectionEvents,
      });
    } else {
      session.status = status;
      if (sessionId && !session.sessionId) {
        session.sessionId = sessionId;
      }
      if (status === 'connected' && !session.connectedAt) {
        session.connectedAt = now;
      }
      if (status === 'ended') {
        session.endedAt = now;
        if (session.connectedAt) {
          const calculated = Math.max(0, Math.floor((now.getTime() - session.connectedAt.getTime()) / 1000));
          session.durationSeconds = durationSeconds !== undefined && durationSeconds > 0 ? durationSeconds : calculated;
        } else {
          session.durationSeconds = 0;
        }
      } else if (durationSeconds !== undefined && durationSeconds > session.durationSeconds) {
        session.durationSeconds = durationSeconds;
      }

      if (event) {
        session.connectionEvents.push({
          event,
          timestamp: now,
          metadata,
        });
      }
      await session.save();
    }

    // Authoritative permanent storage in PostgreSQL call_sessions
    try {
      await queryPostgres(
        `INSERT INTO call_sessions (session_id, consultation_id, user_id, astrologer_id, type, status, duration_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId || `cses_${consultationId}`,
          consultationId,
          userId,
          astrologerId,
          type || 'voice',
          status || 'initiating',
          durationSeconds || 0,
        ]
      );
    } catch (pgErr) {
      console.warn('[PostgreSQL] call_sessions write error:', pgErr);
    }

    return session;
  }

  /**
   * Get call session by consultation ID or sessionId
   */
  static async getCallSession(consultationIdOrSessionId: string): Promise<ICallSession | null> {
    return (
      (await CallSession.findOne({ sessionId: consultationIdOrSessionId })) ||
      (await CallSession.findOne({ consultationId: consultationIdOrSessionId }).sort({ createdAt: -1 }))
    );
  }

  /**
   * Log video session metadata in MongoDB
   */
  static async logVideoSession(data: {
    consultationId: string;
    sessionId: string;
    webrtcRoomId: string;
    status?: 'active' | 'completed' | 'failed';
    qualityMetrics?: any;
    recordingUrl?: string;
    event?: string;
  }): Promise<IVideoCallSession> {
    const {
      consultationId,
      sessionId,
      webrtcRoomId,
      status = 'active',
      qualityMetrics,
      recordingUrl,
      event,
    } = data;

    if (mongoose.connection.readyState !== 1) {
      return {
        consultationId,
        sessionId,
        webrtcRoomId,
        status,
        recordingUrl,
        qualityMetrics: qualityMetrics ? [qualityMetrics] : [],
        connectionEvents: [],
      } as unknown as IVideoCallSession;
    }

    let session = await VideoCallSession.findOne({ sessionId });

    if (!session) {
      session = await VideoCallSession.create({
        consultationId,
        sessionId,
        webrtcRoomId,
        status,
        recordingUrl,
        qualityMetrics: qualityMetrics ? [qualityMetrics] : [],
        connectionEvents: event
          ? [{ event, timestamp: new Date() }]
          : [{ event: 'session_initialized', timestamp: new Date() }],
      });
    } else {
      session.status = status;
      if (recordingUrl) session.recordingUrl = recordingUrl;
      if (qualityMetrics) session.qualityMetrics.push(qualityMetrics);
      if (event) session.connectionEvents.push({ event, timestamp: new Date() });
      await session.save();
    }

    return session;
  }

  /**
   * Get video session by consultation ID or sessionId
   */
  static async getVideoSession(consultationIdOrSessionId: string): Promise<IVideoCallSession | null> {
    if (mongoose.connection.readyState !== 1) {
      return null;
    }
    return (
      (await VideoCallSession.findOne({ sessionId: consultationIdOrSessionId })) ||
      (await VideoCallSession.findOne({ consultationId: consultationIdOrSessionId }).sort({ createdAt: -1 }))
    );
  }

  /**
   * Save authoritative call recording into PostgreSQL and update consultation
   */
  static async saveCallRecording(data: {
    consultationId: string;
    callerId?: string;
    receiverId?: string;
    recordingUrl: string;
    fileName?: string;
    fileSize?: number;
    durationSeconds?: number;
    callType?: string;
    mimeType?: string;
  }): Promise<any> {
    const {
      consultationId,
      callerId,
      receiverId,
      recordingUrl,
      fileName,
      fileSize = 0,
      durationSeconds = 0,
      callType = 'voice',
      mimeType = 'audio/webm',
    } = data;

    // 1. Update consultations table with recording_url
    await queryPostgres(
      `UPDATE consultations
       SET recording_url = $1,
           total_duration_seconds = GREATEST(total_duration_seconds, $2),
           updated_at = NOW()
       WHERE id = $3`,
      [recordingUrl, durationSeconds, consultationId]
    );

    // 2. Insert into call_recordings table
    const result = await queryPostgresSingle(
      `INSERT INTO call_recordings (consultation_id, caller_id, receiver_id, recording_url, file_name, file_size, duration_seconds, call_type, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        consultationId,
        callerId || null,
        receiverId || null,
        recordingUrl,
        fileName || null,
        fileSize,
        durationSeconds,
        callType,
        mimeType,
      ]
    );

    // 3. Update call_sessions if present
    await queryPostgres(
      `UPDATE call_sessions
       SET recording_url = $1,
           duration_seconds = GREATEST(duration_seconds, $2),
           status = 'ended',
           updated_at = NOW()
       WHERE consultation_id = $3`,
      [recordingUrl, durationSeconds, consultationId]
    );

    return result;
  }

  /**
   * Retrieve call recordings for a consultation
   */
  static async getCallRecordings(consultationId: string): Promise<any[]> {
    return queryPostgres(
      `SELECT * FROM call_recordings WHERE consultation_id = $1 ORDER BY created_at DESC`,
      [consultationId]
    );
  }
}
