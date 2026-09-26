import mongoose from 'mongoose';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/jwt.js';
import { ChatMessage } from '../models/mongo/ChatMessage.js';
import { ChatConversation } from '../models/mongo/ChatConversation.js';
import { RealtimeSession } from '../models/mongo/RealtimeSession.js';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { CallsService } from '../services/calls.service.js';
import { BillingService } from '../services/billing.service.js';
import { inMemoryChatStore } from '../controllers/chat.controller.js';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: string;
  tokenExp?: number;
  expiryTimer?: NodeJS.Timeout;
}

let ioInstance: SocketIOServer | null = null;

export function getSocketServer(): SocketIOServer | null {
  return ioInstance;
}

export function disconnectUserSockets(userId: string): void {
  if (!ioInstance || !userId) return;
  ioInstance.to(`user_${userId}`).emit('force_disconnect', { reason: 'session_invalidated' });
  ioInstance.in(`user_${userId}`).disconnectSockets(true);
}

// Set to track processed leave events: `${consultationId}:${userId}`
export const processedLeaveEvents = new Set<string>();

export function initSocketServer(io: SocketIOServer) {
  ioInstance = io;

  // Start authoritative continuous billing engine
  BillingService.startBillingScheduler(io);

  // Handshake authentication middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) {
      // Allow connection with fallback anonymous or reject
      return next();
    }
    try {
      const payload = verifyAccessToken(token);
      socket.userId = payload.userId;
      socket.userRole = payload.role;
      socket.tokenExp = payload.exp;
      next();
    } catch (err) {
      console.warn('[Socket.IO] Authentication failed for socket handshake:', (err as Error).message);
      const authErr = new Error('Authentication failed: ' + (err as Error).message);
      (authErr as any).data = { code: 'TOKEN_EXPIRED', error: (err as Error).message };
      return next(authErr);
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    // Only trust identity verified from JWT in handshake middleware
    const userId = socket.userId || '';
    const userRole = socket.userRole || '';

    if (userId) {
      socket.join(`user_${userId}`);
      socket.join(`role_${userRole}`);
      console.log(`[Socket.IO] User ${userId} (${userRole}) connected and joined user_${userId} & role_${userRole}`);

      // Session Lifetime Protection: Disconnect socket when access token expires
      if (socket.tokenExp) {
        const msUntilExpiry = socket.tokenExp * 1000 - Date.now();
        if (msUntilExpiry > 0) {
          socket.expiryTimer = setTimeout(() => {
            console.log(`[Socket.IO] Token expired for user ${userId}. Emitting auth_expired and disconnecting.`);
            socket.emit('auth_expired', { error: 'Access token expired. Please reauthenticate.' });
            socket.disconnect(true);
          }, msUntilExpiry);
        } else {
          socket.emit('auth_expired', { error: 'Access token expired.' });
          socket.disconnect(true);
          return;
        }
      }

      // If astrologer, update online status in PostgreSQL
      if (userRole === 'astrologer') {
        queryPostgres(
          'UPDATE astrologer_profiles SET is_online = true, updated_at = NOW() WHERE id = $1',
          [userId]
        ).catch((e) => console.error('Error updating astrologer online status:', e));
        io.emit('astrologer_presence_changed', { astrologerId: userId, isOnline: true });
      }
    } else {
      socket.join(`role_${userRole}`);
    }

    // Re-authenticate live socket with refreshed access token
    socket.on('reauthenticate', (data, callback) => {
      const newToken = data?.token;
      if (!newToken) {
        if (callback) callback({ success: false, error: 'Token is required' });
        return;
      }
      try {
        const payload = verifyAccessToken(newToken);
        if (socket.userId && socket.userId !== payload.userId) {
          if (callback) callback({ success: false, error: 'Cannot change socket identity' });
          return;
        }

        socket.userId = payload.userId;
        socket.userRole = payload.role;
        socket.tokenExp = payload.exp;

        if (socket.expiryTimer) {
          clearTimeout(socket.expiryTimer);
        }

        if (payload.exp) {
          const msUntilExpiry = payload.exp * 1000 - Date.now();
          if (msUntilExpiry > 0) {
            socket.expiryTimer = setTimeout(() => {
              socket.emit('auth_expired', { error: 'Access token expired.' });
              socket.disconnect(true);
            }, msUntilExpiry);
          }
        }

        socket.join(`user_${payload.userId}`);
        socket.join(`role_${payload.role}`);

        if (callback) callback({ success: true, message: 'Session refreshed' });
      } catch (err) {
        if (callback) callback({ success: false, error: (err as Error).message });
      }
    });

    // Idempotent leave event processing helper
    const handleUserLeave = async (cId: string, source: 'leave_consultation' | 'disconnecting') => {
      if (!cId || !userId) return;
      const leaveKey = `${cId}:${userId}`;

      // Synchronously claim the leave event to prevent concurrent async race condition
      if (processedLeaveEvents.has(leaveKey)) {
        return;
      }
      processedLeaveEvents.add(leaveKey);

      try {
        const consultation = await queryPostgresSingle(
          'SELECT id, user_id, astrologer_id, state FROM consultations WHERE id = $1',
          [cId]
        );

        if (!consultation) {
          processedLeaveEvents.delete(leaveKey);
          return;
        }

        const isCustomer = consultation.user_id === userId;
        const isAstrologer = consultation.astrologer_id === userId;
        const isAdmin = userRole === 'admin' || userRole === 'super_admin';

        if (!isCustomer && !isAstrologer && !isAdmin) {
          processedLeaveEvents.delete(leaveKey);
          return;
        }

        // If consultation is already ENDED or terminated, do not emit another leave message
        const terminalStates = ['ENDED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];
        if (terminalStates.includes(consultation.state)) {
          console.log(`[Socket.IO] Consultation ${cId} is already in state ${consultation.state}. Skipping leave event.`);
          return;
        }

        const room = `consultation_${cId}`;
        const eventId = `sys_leave_${cId}_${userId}`;
        const timestamp = new Date().toISOString();
        const actor = isCustomer ? 'Customer' : 'Astrologer';
        const contentText = `${actor} left the chat`;

        const leavePayload = {
          id: eventId,
          _id: eventId,
          messageId: eventId,
          type: 'system',
          eventType: isCustomer ? 'customer_left' : 'astrologer_left',
          status: 'ended',
          userId,
          userRole: isCustomer ? 'customer' : 'astrologer',
          consultationId: cId,
          content: contentText,
          text: contentText,
          timestamp,
          createdAt: timestamp,
        };

        // 1. Persist to consultation-isolated in-memory store idempotently
        let memList = inMemoryChatStore.get(cId);
        if (!memList) {
          memList = [];
          inMemoryChatStore.set(cId, memList);
        }
        if (!memList.some((m: any) => m.id === eventId)) {
          memList.push(leavePayload);
        }

        // 2. Persist to MongoDB ChatMessage collection idempotently if connected
        if (mongoose.connection && mongoose.connection.readyState === 1) {
          try {
            await ChatMessage.updateOne(
              { _id: eventId },
              {
                $setOnInsert: {
                  _id: eventId,
                  conversationId: cId,
                  consultationId: cId,
                  senderId: userId,
                  senderRole: isCustomer ? 'customer' : 'astrologer',
                  recipientId: isCustomer ? consultation.astrologer_id : consultation.user_id,
                  messageType: 'system',
                  content: contentText,
                  status: 'delivered',
                  messageId: eventId,
                },
              },
              { upsert: true }
            );
          } catch (dbErr) {
            console.warn('[Socket.IO] MongoDB system leave write warning:', (dbErr as Error).message);
          }
        }

        // 3. Emit EXACTLY ONE authoritative broadcast to the room
        io.to(room).emit('user_left_room', leavePayload);
        console.log(`[Socket.IO] Dispatched single authoritative leave event: id=${eventId}, room=${room}, source=${source}`);
      } catch (err) {
        console.error('[Socket.IO] Error handling user leave:', err);
      }
    };

    socket.on('disconnecting', async () => {
      for (const room of socket.rooms) {
        if (room.startsWith('consultation_')) {
          const cId = room.replace('consultation_', '');
          await handleUserLeave(cId, 'disconnecting');
        }
      }
    });

    socket.on('disconnect', () => {
      if (socket.expiryTimer) {
        clearTimeout(socket.expiryTimer);
      }
    });

    // Join a consultation room with authorization check
    socket.on('join_consultation', async ({ consultationId }) => {
      if (!consultationId || !userId) return;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(consultationId)) return;

      try {
        const consultation = await queryPostgresSingle(
          'SELECT user_id, astrologer_id, state FROM consultations WHERE id = $1',
          [consultationId]
        );

        if (!consultation) return;

        const isParticipant = consultation.user_id === userId || consultation.astrologer_id === userId;
        const isAdmin = userRole === 'admin' || userRole === 'super_admin';

        if (!isParticipant && !isAdmin) {
          console.warn(`[Socket.IO] Unauthorized join_consultation attempt by user ${userId} on room ${consultationId}`);
          return;
        }

        const room = `consultation_${consultationId}`;
        socket.join(room);
        console.log(`[Socket.IO] Socket ${socket.id} (user ${userId}) joined room ${room}`);

        // Reset leave guard in case of legitimate rejoin while consultation is not ended
        const terminalStates = ['ENDED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];
        if (!terminalStates.includes(consultation.state)) {
          processedLeaveEvents.delete(`${consultationId}:${userId}`);
        }

        const isCustomer = consultation.user_id === userId;
        const joinEventId = `sys_join_${consultationId}_${userId}`;
        const timestamp = new Date().toISOString();
        const actor = isCustomer ? 'Customer' : 'Astrologer';
        const contentText = `${actor} joined the chat`;

        const joinPayload = {
          id: joinEventId,
          _id: joinEventId,
          messageId: joinEventId,
          type: 'system',
          eventType: isCustomer ? 'customer_joined' : 'astrologer_joined',
          status: 'joined',
          userId,
          userRole: isCustomer ? 'customer' : 'astrologer',
          consultationId,
          content: contentText,
          text: contentText,
          timestamp,
          createdAt: timestamp,
        };

        // Persist join in memory idempotently
        let memList = inMemoryChatStore.get(consultationId);
        if (!memList) {
          memList = [];
          inMemoryChatStore.set(consultationId, memList);
        }
        if (!memList.some((m: any) => m.id === joinEventId)) {
          memList.push(joinPayload);
        }

        // Emit exactly ONE authoritative join event to room
        socket.to(room).emit('user_joined_room', joinPayload);
      } catch (err) {
        console.error('[Socket.IO] Error in join_consultation:', err);
      }
    });

    // Leave a consultation room
    socket.on('leave_consultation', async ({ consultationId }) => {
      if (!consultationId || !userId) return;
      const room = `consultation_${consultationId}`;
      await handleUserLeave(consultationId, 'leave_consultation');
      socket.leave(room);
      console.log(`[Socket.IO] Socket ${socket.id} (user ${userId}) left room ${room}`);
    });

    // Sequential message processor chain to preserve strict FIFO delivery order
    let messageProcessChain: Promise<void> = Promise.resolve();

    // Send a real-time message
    socket.on('send_message', (data, callback) => {
      messageProcessChain = messageProcessChain.then(async () => {
        try {
          console.log('[Socket.IO] send_message received from socket', socket.id, 'data:', JSON.stringify(data));
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        const { consultationId, recipientId, content, messageType = 'text', mediaUrl, metadata } = parsed;
        if (!userId) {
          console.warn('[Socket.IO] send_message rejected - unauthenticated socket:', socket.id);
          if (callback) callback({ success: false, error: 'Unauthorized: Authentication required to send messages' });
          return;
        }

        // 2. Verify senderId matches socket.userId if provided
        if (parsed.senderId && parsed.senderId !== userId && userRole !== 'admin' && userRole !== 'super_admin') {
          console.warn(`[Socket.IO] send_message rejected - senderId mismatch (client: ${parsed.senderId}, auth: ${userId})`);
          if (callback) callback({ success: false, error: 'Forbidden: Sender identity mismatch' });
          return;
        }

        const senderId = userId;
        const senderRole = userRole || (senderId.includes('astrologer') ? 'astrologer' : 'customer');

        if (!consultationId || !content) {
          console.warn('[Socket.IO] send_message rejected - missing fields:', { consultationId, content });
          if (callback) callback({ success: false, error: 'Missing consultationId or content' });
          return;
        }

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(consultationId)) {
          console.warn('[Socket.IO] send_message rejected - invalid consultationId UUID format:', consultationId);
          if (callback) callback({ success: false, error: 'Invalid consultationId UUID format' });
          return;
        }

        // 3. Verify consultation exists in PostgreSQL
        const consultation = await queryPostgresSingle(
          'SELECT id, user_id, astrologer_id, state FROM consultations WHERE id = $1',
          [consultationId]
        );

        if (!consultation) {
          console.warn('[Socket.IO] send_message rejected - consultation not found:', consultationId);
          if (callback) callback({ success: false, error: 'Consultation not found' });
          return;
        }

        // 4. Verify consultation is ACTIVE (REQUESTED, ACCEPTED, ACTIVE, IN_PROGRESS)
        const activeStates = ['REQUESTED', 'ACCEPTED', 'ACTIVE', 'IN_PROGRESS'];
        if (!activeStates.includes(consultation.state)) {
          console.warn(`[Socket.IO] send_message rejected - consultation is not active (state: ${consultation.state}):`, consultationId);
          if (callback) callback({ success: false, error: `Consultation is ${consultation.state.toLowerCase()}` });
          return;
        }

        // 5. Verify sender belongs to that consultation
        const isParticipant = consultation.user_id === userId || consultation.astrologer_id === userId;
        const isAdmin = userRole === 'admin' || userRole === 'super_admin';
        if (!isParticipant && !isAdmin) {
          console.warn(`[Socket.IO] send_message rejected - user ${userId} not a participant in consultation ${consultationId}`);
          if (callback) callback({ success: false, error: 'Unauthorized: Not a participant in this consultation' });
          return;
        }

        // 6. Verify recipient belongs to that consultation
        const expectedRecipient = consultation.user_id === userId ? consultation.astrologer_id : consultation.user_id;
        if (recipientId && recipientId !== expectedRecipient && !isAdmin) {
          console.warn(`[Socket.IO] send_message rejected - recipient mismatch (provided: ${recipientId}, expected: ${expectedRecipient})`);
          if (callback) callback({ success: false, error: 'Forbidden: Recipient does not belong to this consultation' });
          return;
        }
        const effectiveRecipientId = expectedRecipient;

        const conversationId = consultationId;

        const messageId = parsed.id || parsed._id || `${Date.now()}-${Math.random().toString(36).substring(7)}`;

        // Persist message in MongoDB (if connected)
        const messagePayload: any = {
          conversationId,
          consultationId,
          senderId,
          senderRole,
          recipientId: effectiveRecipientId,
          messageType,
          content,
          mediaUrl,
          status: 'sent',
          metadata: metadata || {},
        };
        if (parsed.id || parsed._id) {
          messagePayload._id = parsed.id || parsed._id;
        }

        let savedMessage: any = {
          ...messagePayload,
          _id: messageId,
          id: messageId,
          text: content,
          consultationId,
          consultation_id: consultationId,
          senderId,
          sender_id: senderId,
          createdAt: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };

        if (mongoose.connection.readyState === 1) {
          try {
            const doc = await ChatMessage.create(messagePayload);
            const obj = doc.toObject ? doc.toObject() : doc;
            const finalId = (obj._id || doc._id || messageId).toString();
            savedMessage = {
              ...obj,
              id: finalId,
              _id: finalId,
              text: obj.content || content,
              content: obj.content || content,
              consultationId: obj.consultationId || consultationId,
              consultation_id: obj.consultationId || consultationId,
              senderId: obj.senderId || senderId,
              sender_id: obj.senderId || senderId,
              createdAt: obj.createdAt || savedMessage.createdAt,
              created_at: obj.createdAt || savedMessage.created_at,
            };

            // Update or create conversation summary
            await ChatConversation.findOneAndUpdate(
              { consultationId },
              {
                $set: {
                  lastMessage: {
                    senderId,
                    content,
                    messageType,
                    createdAt: new Date(),
                  },
                  isActive: true,
                },
              },
              { upsert: true, new: true }
            );
          } catch (dbErr) {
            console.warn('[Socket.IO] MongoDB write fallback (using in-memory broadcast):', (dbErr as Error).message);
          }
        }

        // Transition chat consultation to ACTIVE upon message exchange if not already ACTIVE
        if (consultation.state !== 'ACTIVE') {
          await queryPostgres(
            `UPDATE consultations
             SET state = 'ACTIVE', start_time = COALESCE(start_time, NOW()), updated_at = NOW()
             WHERE id = $1 AND state IN ('REQUESTED', 'ACCEPTED')`,
            [consultationId]
          );
          await queryPostgres('UPDATE astrologer_profiles SET is_busy = true WHERE id = $1', [consultation.astrologer_id]);
        }

        const room = `consultation_${consultationId}`;
        console.log(`BACKEND EMIT:\nroom=${room}`);
        console.log(`[Socket.IO] Emitting chat message strictly to room=${room}`);
        
        // Persist in consultation-isolated in-memory store
        let memList = inMemoryChatStore.get(consultationId);
        if (!memList) {
          memList = [];
          inMemoryChatStore.set(consultationId, memList);
        }
        if (!memList.some((m: any) => m.id === savedMessage.id)) {
          memList.push(savedMessage);
        }

        // Broadcast chat messages strictly to the consultation room
        io.to(room).emit('new_message', savedMessage);
        io.to(room).emit('chat_message', savedMessage);
        io.to(room).emit('receive_message', savedMessage);

        // Notify recipient's device if they have not yet entered the room
        if (effectiveRecipientId) {
          io.to(`user_${effectiveRecipientId}`).emit('incoming_chat', savedMessage);
        }

        if (callback) callback({ success: true, message: savedMessage });
      } catch (err) {
        console.error('[Socket.IO] Error in send_message:', err);
        if (callback) callback({ success: false, error: (err as Error).message });
      }
    }).catch((chainErr) => {
      console.error('[Socket.IO] Sequential chain error:', chainErr);
    });
  });

    // Typing indicators
    socket.on('typing_start', ({ consultationId }) => {
      if (consultationId) {
        socket.to(`consultation_${consultationId}`).emit('user_typing_start', { userId, consultationId });
      }
    });

    socket.on('typing_stop', ({ consultationId }) => {
      if (consultationId) {
        socket.to(`consultation_${consultationId}`).emit('user_typing_stop', { userId, consultationId });
      }
    });

    // =============================================================
    // WebRTC / Voice & Video Call Signaling Infrastructure
    // =============================================================

    async function validateCallParticipant(consId: string, uId?: string) {
      if (!consId) return null;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(consId)) return null;
      try {
        const cons = await queryPostgresSingle('SELECT * FROM consultations WHERE id = $1', [consId]);
        if (!cons) return null;
        const isParticipant = cons.user_id === uId || cons.astrologer_id === uId;
        const isAdmin = userRole === 'admin' || userRole === 'super_admin';
        if (!isParticipant && !isAdmin) {
          return null;
        }
        return cons;
      } catch (err) {
        console.error('[Socket.IO] Error validating call participant:', err);
        return null;
      }
    }

    // 1. Call Invite (Initiate call)
    socket.on('call_invite', async (data, callback) => {
      const { consultationId, type = 'voice', sessionId, callerName } = data || {};
      if (!userId) {
        if (callback) callback({ success: false, error: 'Unauthorized: Authentication required to initiate calls' });
        return;
      }
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) {
        if (callback) callback({ success: false, error: 'Unauthorized or invalid consultation' });
        return;
      }

      const effectiveCallerId = userId;
      const recipientId = consultation.user_id === effectiveCallerId ? consultation.astrologer_id : consultation.user_id;
      const effectiveSessionId = sessionId || `cses_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      try {
        await CallsService.logCallSession({
          consultationId,
          sessionId: effectiveSessionId,
          userId: consultation.user_id,
          astrologerId: consultation.astrologer_id,
          type,
          status: 'ringing',
          event: 'call_invited',
        });

        const invitePayload = {
          consultationId,
          sessionId: effectiveSessionId,
          callerId: effectiveCallerId,
          callerName: callerName || (effectiveCallerId === consultation.user_id ? 'Customer' : 'Astrologer'),
          type,
          status: 'ringing',
          timestamp: new Date().toISOString(),
        };

        socket.to(`consultation_${consultationId}`).emit('call_invite', invitePayload);
        socket.to(`consultation_${consultationId}`).emit('call_offer', invitePayload);
        socket.to(`consultation_${consultationId}`).emit('incoming_call', invitePayload);
        if (recipientId) {
          io.to(`user_${recipientId}`).emit('call_invite', invitePayload);
          io.to(`user_${recipientId}`).emit('incoming_call', invitePayload);
        }
        if (callback) callback({ success: true, sessionId: effectiveSessionId });
      } catch (err) {
        console.error('[Socket.IO] Error processing call_invite:', err);
        if (callback) callback({ success: false, error: (err as Error).message });
      }
    });

    // 2. Call Accept
    socket.on('call_accept', async (data) => {
      const { consultationId, sessionId } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      await CallsService.logCallSession({
        consultationId,
        sessionId,
        userId: consultation.user_id,
        astrologerId: consultation.astrologer_id,
        status: 'accepted',
        event: 'call_accepted',
      });

      const acceptPayload = { consultationId, sessionId, acceptedBy: userId, timestamp: new Date().toISOString() };
      io.to(`consultation_${consultationId}`).emit('call_accept', acceptPayload);
      io.to(`consultation_${consultationId}`).emit('call_accepted', acceptPayload);
    });

    // 3. Call Reject
    socket.on('call_reject', async (data) => {
      const { consultationId, sessionId, reason = 'declined' } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      await CallsService.logCallSession({
        consultationId,
        sessionId,
        userId: consultation.user_id,
        astrologerId: consultation.astrologer_id,
        status: 'rejected',
        event: 'call_rejected',
        metadata: { reason },
      });

      const rejectPayload = { consultationId, sessionId, reason, timestamp: new Date().toISOString() };
      io.to(`consultation_${consultationId}`).emit('call_reject', rejectPayload);
      io.to(`consultation_${consultationId}`).emit('call_rejected', rejectPayload);
    });

    // 4. WebRTC Offer Relay
    socket.on('webrtc_offer', async (data) => {
      const { consultationId, sessionId, sdp, offer } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      const payload = {
        consultationId,
        sessionId,
        sdp: sdp || offer,
        offer: sdp || offer,
        from: userId,
      };
      socket.to(`consultation_${consultationId}`).emit('webrtc_offer', payload);
      socket.to(`consultation_${consultationId}`).emit('call_offer', payload);
    });

    socket.on('call_offer', async (data) => {
      const { consultationId, sessionId, sdp, offer } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      const payload = {
        consultationId,
        sessionId,
        sdp: sdp || offer,
        offer: sdp || offer,
        from: userId,
      };
      socket.to(`consultation_${consultationId}`).emit('webrtc_offer', payload);
      socket.to(`consultation_${consultationId}`).emit('call_offer', payload);
    });

    // 5. WebRTC Answer Relay
    socket.on('webrtc_answer', async (data) => {
      const { consultationId, sessionId, sdp, answer } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      const payload = {
        consultationId,
        sessionId,
        sdp: sdp || answer,
        answer: sdp || answer,
        from: userId,
      };
      socket.to(`consultation_${consultationId}`).emit('webrtc_answer', payload);
      socket.to(`consultation_${consultationId}`).emit('call_answer', payload);
    });

    socket.on('call_answer', async (data) => {
      const { consultationId, sessionId, sdp, answer } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      const payload = {
        consultationId,
        sessionId,
        sdp: sdp || answer,
        answer: sdp || answer,
        from: userId,
      };
      socket.to(`consultation_${consultationId}`).emit('webrtc_answer', payload);
      socket.to(`consultation_${consultationId}`).emit('call_answer', payload);
    });

    // 6. ICE Candidate Relay
    socket.on('webrtc_ice_candidate', async (data) => {
      const { consultationId, sessionId, candidate } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      const payload = {
        consultationId,
        sessionId,
        candidate,
        from: userId,
      };
      socket.to(`consultation_${consultationId}`).emit('webrtc_ice_candidate', payload);
      socket.to(`consultation_${consultationId}`).emit('ice_candidate', payload);
    });

    socket.on('ice_candidate', async (data) => {
      const { consultationId, sessionId, candidate } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      const payload = {
        consultationId,
        sessionId,
        candidate,
        from: userId,
      };
      socket.to(`consultation_${consultationId}`).emit('webrtc_ice_candidate', payload);
      socket.to(`consultation_${consultationId}`).emit('ice_candidate', payload);
    });

    // 7. WebRTC Call Connected Notification
    socket.on('call_connected', async (data) => {
      const { consultationId, sessionId } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      // Transition voice/video call consultation to ACTIVE upon call_connected
      await queryPostgres(
        `UPDATE consultations
         SET state = 'ACTIVE', start_time = COALESCE(start_time, NOW()), updated_at = NOW()
         WHERE id = $1 AND state IN ('REQUESTED', 'ACCEPTED')`,
        [consultationId]
      );
      await queryPostgres('UPDATE astrologer_profiles SET is_busy = true WHERE id = $1', [consultation.astrologer_id]);

      await CallsService.logCallSession({
        consultationId,
        sessionId,
        userId: consultation.user_id,
        astrologerId: consultation.astrologer_id,
        status: 'connected',
        event: 'webrtc_connected',
      });

      io.to(`consultation_${consultationId}`).emit('call_connected', {
        consultationId,
        sessionId,
        connectedAt: new Date().toISOString(),
      });
    });

    // 8. Call End & Authoritative Finalization
    const handleCallEnd = async (data: any) => {
      const { consultationId, sessionId, durationSeconds } = data || {};
      const consultation = await validateCallParticipant(consultationId, userId);
      if (!consultation) return;

      try {
        const session = await CallsService.logCallSession({
          consultationId,
          sessionId,
          userId: consultation.user_id,
          astrologerId: consultation.astrologer_id,
          status: 'ended',
          durationSeconds,
          event: 'call_ended',
        });

        // Trigger billing finalization safely
        const finalDuration = session.durationSeconds || durationSeconds || 0;
        await BillingService.endAndBillConsultation({
          consultationId,
          callerUserId: userId || consultation.user_id,
          callerRole: userRole,
          durationSeconds: finalDuration,
        });

        const endPayload = {
          consultationId,
          sessionId,
          endedBy: userId || consultation.user_id,
          durationSeconds: finalDuration,
          timestamp: new Date().toISOString(),
        };

        io.to(`consultation_${consultationId}`).emit('call_end', endPayload);
        io.to(`consultation_${consultationId}`).emit('call_ended', endPayload);
      } catch (err) {
        console.error('[Socket.IO] Error ending call session:', err);
      }
    };

    socket.on('call_end', handleCallEnd);
    socket.on('call_ended', handleCallEnd);

    // Disconnect handling
    socket.on('disconnect', (reason) => {
      if (userId && userRole === 'astrologer') {
        queryPostgres(
          'UPDATE astrologer_profiles SET is_online = false, updated_at = NOW() WHERE id = $1',
          [userId]
        ).catch((e) => console.error('Error updating astrologer offline status:', e));
        io.emit('astrologer_presence_changed', { astrologerId: userId, isOnline: false });
      }
      console.log(`[Socket.IO] Socket ${socket.id} (user ${userId}) disconnected. Reason: ${reason}`);
    });
  });
}
