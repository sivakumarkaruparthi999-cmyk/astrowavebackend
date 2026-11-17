import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { ChatMessage } from '../models/mongo/ChatMessage.js';
import { ChatConversation } from '../models/mongo/ChatConversation.js';
import fs from 'fs';
import { StorageService, validateFileMagicBytes } from '../services/storage.service.js';
import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { getSocketServer } from '../websocket/socket.server.js';
import mongoose from 'mongoose';

// Authoritative Consultation-Isolated In-Memory Chat Store (Key: consultationId)
export const inMemoryChatStore = new Map<string, any[]>();

export class ChatController {
  static async listMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { consultationId } = req.params;
      const callerId = req.user?.userId;
      const callerRole = req.user?.role?.toLowerCase();
      const { limit = 100, before } = req.query;

      if (!callerId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      // Verify caller is a participant in this consultation or admin (BOLA check)
      const consultation = await queryPostgresSingle(
        'SELECT user_id, astrologer_id FROM consultations WHERE id = $1',
        [consultationId]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found' });
        return;
      }

      const isCustomer = consultation.user_id === callerId;
      const isAstrologer = consultation.astrologer_id === callerId;
      const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';

      if (!isCustomer && !isAstrologer && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to access these messages' });
        return;
      }

      let messages: any[] = [];

      // 1. Authoritative persistent storage: PostgreSQL chat_messages
      try {
        const pgRows = await queryPostgres(
          `SELECT id, consultation_id, sender_id, recipient_id, sender_role, message_type, content, media_url, status, metadata, created_at
           FROM chat_messages
           WHERE consultation_id = $1
           ORDER BY created_at ASC
           LIMIT $2`,
          [consultationId, Number(limit) || 100]
        );
        if (pgRows && pgRows.length > 0) {
          messages = pgRows.map((r: any) => ({
            id: r.id,
            _id: r.id,
            consultationId: r.consultation_id,
            consultation_id: r.consultation_id,
            senderId: r.sender_id,
            sender_id: r.sender_id,
            recipientId: r.recipient_id,
            senderRole: r.sender_role,
            sender: r.sender_role,
            messageType: r.message_type,
            content: r.content,
            text: r.content,
            mediaUrl: r.media_url,
            status: r.status,
            metadata: r.metadata,
            createdAt: r.created_at,
            created_at: r.created_at,
          }));
        }
      } catch (pgErr) {
        console.warn('[PostgreSQL] query warning in listMessages:', pgErr);
      }

      // 2. Secondary fallback: MongoDB (if connected and PostgreSQL had 0 records)
      if (messages.length === 0 && mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          const query: any = {
            $or: [
              { consultationId },
              { conversationId: consultationId }
            ]
          };
          if (before) {
            query.createdAt = { $lt: new Date(before as string) };
          }

          const rawMessages = await ChatMessage.find(query)
            .sort({ createdAt: 1 })
            .limit(Number(limit));

          messages = rawMessages.map((doc) => {
            const obj = doc.toObject ? doc.toObject() : doc;
            const msgId = (obj._id || doc._id || '').toString();
            const effectiveRole =
              obj.senderId === consultation.user_id
                ? 'customer'
                : obj.senderId === consultation.astrologer_id
                ? 'astrologer'
                : obj.senderRole || obj.sender || 'customer';

            return {
              ...obj,
              id: msgId,
              _id: msgId,
              text: obj.content,
              content: obj.content,
              consultationId: obj.consultationId || obj.conversationId,
              consultation_id: obj.consultationId || obj.conversationId,
              senderId: obj.senderId,
              sender_id: obj.senderId,
              senderRole: effectiveRole,
              sender: effectiveRole,
              createdAt: obj.createdAt,
              created_at: obj.createdAt,
            };
          });
        } catch (mongoErr) {
          console.warn('MongoDB query warning in listMessages:', mongoErr);
        }
      }

      // If MongoDB is offline or returned 0 messages, retrieve from consultation-isolated in-memory store
      if (messages.length === 0) {
        const memList = inMemoryChatStore.get(consultationId) || [];
        messages = memList.slice(-Number(limit)).map((m: any) => {
          const effectiveRole =
            m.senderId === consultation.user_id
              ? 'customer'
              : m.senderId === consultation.astrologer_id
              ? 'astrologer'
              : m.senderRole || m.sender || 'customer';
          return {
            ...m,
            senderRole: effectiveRole,
            sender: effectiveRole,
          };
        });
      }

      // Deduplicate messages in case a client sent duplicate via socket and HTTP or multiple retries
      const deduplicated: any[] = [];
      for (const msg of messages) {
        const isDuplicate = deduplicated.some((existing) => {
          if (existing.id && msg.id && existing.id === msg.id) return true;
          if (existing._id && msg._id && existing._id === msg._id) return true;
          if (
            (existing.senderId || existing.sender_id) === (msg.senderId || msg.sender_id) &&
            (existing.content || existing.text) === (msg.content || msg.text)
          ) {
            const timeDiff = Math.abs(
              new Date(existing.createdAt || existing.created_at || Date.now()).getTime() -
              new Date(msg.createdAt || msg.created_at || Date.now()).getTime()
            );
            if (timeDiff < 3000) return true;
          }
          return false;
        });
        if (!isDuplicate) {
          deduplicated.push(msg);
        }
      }

      res.status(200).json({ success: true, data: deduplicated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const userRole = req.user?.role?.toLowerCase() || 'customer';
      const { consultationId, recipientId, content, text, message, messageType = 'text', mediaUrl, metadata, id, _id } = req.body;
      const effectiveContent = content || text || message;

      if (!consultationId || !effectiveContent || !userId) {
        res.status(400).json({ success: false, error: 'Missing required fields' });
        return;
      }

      // Verify caller is an authorized participant in this consultation
      const consultation = await queryPostgresSingle(
        'SELECT user_id, astrologer_id FROM consultations WHERE id = $1',
        [consultationId]
      );

      if (!consultation) {
        res.status(404).json({ success: false, error: 'Consultation not found' });
        return;
      }

      const isCustomer = consultation.user_id === userId;
      const isAstrologer = consultation.astrologer_id === userId;
      const isAdmin = userRole === 'admin' || userRole === 'super_admin';

      if (!isCustomer && !isAstrologer && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to send messages in this consultation' });
        return;
      }

      const expectedRecipient = isCustomer ? consultation.astrologer_id : consultation.user_id;
      const isPlaceholder = !recipientId || recipientId === 'customer_user' || recipientId === 'astrologer_user' || recipientId === 'live_chat';
      const recipientMatches = isPlaceholder || recipientId === expectedRecipient;

      console.log(`[CHAT_AUTH_DEBUG] consultationId=${consultationId} authenticatedUserId=${userId} senderId=${userId} recipientId=${recipientId || expectedRecipient} consultationCustomerId=${consultation.user_id} consultationAstrologerId=${consultation.astrologer_id} senderRole=${userRole} recipientMatches=${recipientMatches} senderMatches=${isCustomer || isAstrologer || isAdmin}`);

      if (!isPlaceholder && recipientId !== expectedRecipient && !isAdmin) {
        res.status(403).json({ success: false, error: 'Forbidden: Recipient does not belong to this consultation' });
        return;
      }

      const targetRecipientId = expectedRecipient;

      const effectiveSenderRole = isCustomer ? 'customer' : (isAstrologer ? 'astrologer' : userRole);

      // Deduplication check: if a message with the same sender, consultation, and content arrived in the last 3 seconds (or same ID), return existing
      const existingList = inMemoryChatStore.get(consultationId) || [];
      const incomingId = id || _id;
      const recentDuplicate = existingList.find((m: any) => {
        if (incomingId && (m.id === incomingId || m._id === incomingId)) return true;
        if (m.senderId === userId && (m.content === effectiveContent || m.text === effectiveContent)) {
          const diff = Math.abs(Date.now() - new Date(m.createdAt || m.created_at || Date.now()).getTime());
          if (diff < 3000) return true;
        }
        return false;
      });

      if (recentDuplicate) {
        console.log(`[HTTP Chat] Deduplicated message for consultation ${consultationId}`);
        res.status(200).json({ success: true, data: recentDuplicate });
        return;
      }

      const messageId = id || _id || `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const msgData: any = {
        conversationId: consultationId,
        consultationId,
        senderId: userId,
        senderRole: effectiveSenderRole,
        sender: effectiveSenderRole,
        recipientId: targetRecipientId,
        messageType,
        content: effectiveContent,
        text: effectiveContent,
        mediaUrl,
        status: 'sent',
        metadata: metadata || {},
        createdAt: new Date(),
        id: messageId,
        _id: messageId,
      };

      let saved: any = msgData;
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          const doc = await ChatMessage.create(msgData);
          saved = doc.toObject ? doc.toObject() : doc;
          const finalId = (saved._id || doc._id || messageId || '').toString();
          saved.id = finalId;
          saved._id = finalId;
          saved.text = saved.content;
          saved.consultationId = saved.consultationId || consultationId;
          saved.consultation_id = saved.consultationId;
          saved.senderId = saved.senderId || userId;
          saved.sender_id = saved.senderId;
          saved.createdAt = saved.createdAt || new Date();
          saved.created_at = saved.createdAt;

          await ChatConversation.findOneAndUpdate(
            { consultationId },
            {
              $set: {
                lastMessage: {
                  senderId: userId,
                  content: effectiveContent,
                  messageType,
                  createdAt: new Date(),
                },
                isActive: true,
              },
            },
            { upsert: true, new: true }
          );
        } catch (mongoErr) {
          console.warn('MongoDB fallback in sendMessage:', mongoErr);
        }
      }

      // Authoritative permanent storage in PostgreSQL chat_messages
      try {
        const isUuid = saved.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.id);
        const pgId = isUuid ? saved.id : undefined;
        const pgResult = await queryPostgresSingle(
          `INSERT INTO chat_messages (id, consultation_id, sender_id, recipient_id, sender_role, message_type, content, media_url, status, metadata, created_at)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content
           RETURNING id, created_at`,
          [
            pgId,
            consultationId,
            userId,
            targetRecipientId,
            effectiveSenderRole,
            messageType,
            effectiveContent,
            mediaUrl || null,
            'sent',
            JSON.stringify(metadata || {}),
            saved.createdAt || new Date(),
          ]
        );
        if (pgResult?.id) {
          saved.id = pgResult.id;
          saved._id = pgResult.id;
        }
      } catch (pgErr) {
        console.error('[PostgreSQL] chat_messages insert error:', pgErr);
      }

      // Persist in consultation-isolated in-memory store
      let list = inMemoryChatStore.get(consultationId);
      if (!list) {
        list = [];
        inMemoryChatStore.set(consultationId, list);
      }
      if (!list.some(m => m.id === saved.id)) {
        list.push(saved);
      }

      // Authoritative realtime WebSocket broadcast to room and recipient
      const io = getSocketServer();
      if (io) {
        const room = `consultation_${consultationId}`;
        console.log(`[HTTP Chat] Emitting message ${saved.id} to room ${room}`);
        io.to(room).emit('chat_message', saved);
        if (targetRecipientId) {
          io.to(`user_${targetRecipientId}`).emit('incoming_chat', saved);
        }
      }

      res.status(201).json({ success: true, data: saved });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  static async uploadMedia(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'No file uploaded' });
        return;
      }

      // Deep inspection: verify file magic bytes / signature matches valid binary format
      const magicCheck = await validateFileMagicBytes(req.file.path);
      if (!magicCheck.valid) {
        if (fs.existsSync(req.file.path)) {
          await fs.promises.unlink(req.file.path);
        }
        res.status(400).json({
          success: false,
          error: 'File signature mismatch: binary content does not match allowed format',
        });
        return;
      }

      const fileUrl = StorageService.getFileUrl('chat', req.file.filename);
      res.status(200).json({
        success: true,
        data: {
          fileUrl,
          filename: req.file.filename,
          size: req.file.size,
          mimetype: req.file.mimetype,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
