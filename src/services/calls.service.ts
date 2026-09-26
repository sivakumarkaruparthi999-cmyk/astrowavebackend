import mongoose from 'mongoose';
import { CallSession, ICallSession } from '../models/mongo/CallSession.js';
import { VideoCallSession, IVideoCallSession } from '../models/mongo/VideoCallSession.js';

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
}
