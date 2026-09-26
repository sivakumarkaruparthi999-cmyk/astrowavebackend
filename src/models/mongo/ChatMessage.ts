import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage extends Document {
  conversationId: string;
  consultationId?: string;
  senderId: string;
  senderRole: string;
  recipientId: string;
  messageType: 'text' | 'image' | 'audio' | 'kundli' | 'system';
  content: string;
  mediaUrl?: string;
  status: 'sent' | 'delivered' | 'read';
  metadata?: Record<string, any>;
  messageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema: Schema = new Schema(
  {
    _id: { type: Schema.Types.Mixed, default: () => new mongoose.Types.ObjectId().toString() },
    conversationId: { type: String, required: true, index: true },
    consultationId: { type: String },
    senderId: { type: String, required: true, index: true },
    senderRole: { type: String, required: true, default: 'customer' },
    recipientId: { type: String, required: true, index: true },
    messageType: {
      type: String,
      enum: ['text', 'image', 'audio', 'kundli', 'system'],
      default: 'text',
    },
    content: { type: String, required: true },
    mediaUrl: { type: String },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read'],
      default: 'sent',
    },
    messageId: { type: String, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ChatMessageSchema.index({ conversationId: 1, createdAt: -1 });
ChatMessageSchema.index({ consultationId: 1, createdAt: -1 });
ChatMessageSchema.index({ senderId: 1, createdAt: -1 });
ChatMessageSchema.index({ recipientId: 1, createdAt: -1 });
ChatMessageSchema.index({ createdAt: -1 });

export const ChatMessage = mongoose.models.ChatMessage || mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);
