import mongoose, { Schema, Document } from 'mongoose';

export interface IParticipant {
  userId: string;
  role: string;
  unreadCount: number;
}

export interface IChatConversation extends Document {
  consultationId?: string;
  participants: IParticipant[];
  lastMessage?: {
    senderId: string;
    content: string;
    messageType: string;
    createdAt: Date;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ParticipantSchema = new Schema(
  {
    userId: { type: String, required: true },
    role: { type: String, required: true },
    unreadCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const ChatConversationSchema: Schema = new Schema(
  {
    consultationId: { type: String, index: true },
    participants: [ParticipantSchema],
    lastMessage: {
      senderId: { type: String },
      content: { type: String },
      messageType: { type: String, default: 'text' },
      createdAt: { type: Date },
    },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

ChatConversationSchema.index({ 'participants.userId': 1 });
ChatConversationSchema.index({ updatedAt: -1 });

export const ChatConversation =
  mongoose.models.ChatConversation ||
  mongoose.model<IChatConversation>('ChatConversation', ChatConversationSchema);
