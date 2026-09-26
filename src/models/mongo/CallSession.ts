import mongoose, { Schema, Document } from 'mongoose';

export interface IConnectionEvent {
  event: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface ICallSession extends Document {
  sessionId?: string;
  consultationId: string;
  userId: string;
  astrologerId: string;
  type: 'voice' | 'video';
  status: 'initiating' | 'ringing' | 'accepted' | 'connecting' | 'connected' | 'ended' | 'missed' | 'rejected' | 'cancelled' | 'failed';
  startedAt?: Date;
  connectedAt?: Date;
  endedAt?: Date;
  durationSeconds: number;
  connectionEvents: IConnectionEvent[];
  createdAt: Date;
  updatedAt: Date;
}

const ConnectionEventSchema = new Schema(
  {
    event: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const CallSessionSchema: Schema = new Schema(
  {
    sessionId: { type: String, index: true },
    consultationId: { type: String, required: true },
    userId: { type: String, required: true },
    astrologerId: { type: String, required: true },
    type: {
      type: String,
      enum: ['voice', 'video'],
      default: 'voice',
    },
    status: {
      type: String,
      enum: [
        'initiating',
        'ringing',
        'accepted',
        'connecting',
        'connected',
        'ended',
        'missed',
        'rejected',
        'cancelled',
        'failed',
      ],
      default: 'initiating',
    },
    startedAt: { type: Date },
    connectedAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number, default: 0 },
    connectionEvents: [ConnectionEventSchema],
  },
  {
    timestamps: true,
  }
);

CallSessionSchema.index({ consultationId: 1, createdAt: -1 });
CallSessionSchema.index({ userId: 1, createdAt: -1 });
CallSessionSchema.index({ astrologerId: 1, createdAt: -1 });

export const CallSession =
  mongoose.models.CallSession || mongoose.model<ICallSession>('CallSession', CallSessionSchema);
