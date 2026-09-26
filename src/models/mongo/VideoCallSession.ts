import mongoose, { Schema, Document } from 'mongoose';

export interface IVideoQualityMetric {
  bitrate?: number;
  packetLoss?: number;
  resolution?: string;
  latencyMs?: number;
  timestamp: Date;
}

export interface IVideoCallSession extends Document {
  consultationId: string;
  sessionId: string;
  webrtcRoomId: string;
  status: 'active' | 'completed' | 'failed';
  recordingUrl?: string;
  qualityMetrics: IVideoQualityMetric[];
  connectionEvents: Array<{
    event: string;
    timestamp: Date;
    details?: Record<string, any>;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const VideoQualityMetricSchema = new Schema(
  {
    bitrate: { type: Number },
    packetLoss: { type: Number },
    resolution: { type: String },
    latencyMs: { type: Number },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const VideoCallSessionSchema: Schema = new Schema(
  {
    consultationId: { type: String, required: true },
    sessionId: { type: String, required: true, unique: true },
    webrtcRoomId: { type: String, required: true },
    status: {
      type: String,
      enum: ['active', 'completed', 'failed'],
      default: 'active',
    },
    recordingUrl: { type: String },
    qualityMetrics: [VideoQualityMetricSchema],
    connectionEvents: [
      {
        event: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        details: { type: Schema.Types.Mixed, default: {} },
      },
    ],
  },
  {
    timestamps: true,
  }
);

VideoCallSessionSchema.index({ consultationId: 1 });

export const VideoCallSession =
  mongoose.models.VideoCallSession ||
  mongoose.model<IVideoCallSession>('VideoCallSession', VideoCallSessionSchema);
