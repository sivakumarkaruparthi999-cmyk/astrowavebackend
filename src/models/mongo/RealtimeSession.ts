import mongoose, { Schema, Document } from 'mongoose';

export interface IRealtimeSession extends Document {
  consultationId: string;
  userId: string;
  astrologerId: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'ended';
  startedAt: Date;
  lastPing: Date;
  durationSeconds: number;
  callMetadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const RealtimeSessionSchema: Schema = new Schema(
  {
    consultationId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    astrologerId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['connecting', 'connected', 'reconnecting', 'disconnected', 'ended'],
      default: 'connecting',
    },
    startedAt: { type: Date, default: Date.now },
    lastPing: { type: Date, default: Date.now },
    durationSeconds: { type: Number, default: 0 },
    callMetadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  }
);

export const RealtimeSession =
  mongoose.models.RealtimeSession ||
  mongoose.model<IRealtimeSession>('RealtimeSession', RealtimeSessionSchema);
