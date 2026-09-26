import mongoose, { Schema, Document } from 'mongoose';

export interface INotificationLog extends Document {
  userId: string;
  title: string;
  body: string;
  type: string;
  channel: string;
  payload: Record<string, any>;
  status: 'pending' | 'sent' | 'failed' | 'delivered';
  failureReason?: string;
  createdAt: Date;
}

const NotificationLogSchema: Schema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: { type: String, required: true },
    channel: { type: String, default: 'in_app' },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'delivered'],
      default: 'sent',
    },
    failureReason: { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

NotificationLogSchema.index({ userId: 1, createdAt: -1 });

export const NotificationLog =
  mongoose.models.NotificationLog ||
  mongoose.model<INotificationLog>('NotificationLog', NotificationLogSchema);
