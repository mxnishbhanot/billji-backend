import mongoose from 'mongoose';

export const NOTIFICATION_TONES = ['danger', 'warning', 'info'];

const notificationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    notificationId: { type: String, required: true, trim: true, maxlength: 180 },
    type: { type: String, required: true, trim: true, maxlength: 80, index: true },
    resourceType: { type: String, required: true, trim: true, maxlength: 40 },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    tone: { type: String, enum: NOTIFICATION_TONES, default: 'info' },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    to: { type: String, default: '', trim: true, maxlength: 240 },
    sortDate: { type: Date, default: Date.now, index: true },
    priority: { type: Number, default: 3, min: 1, max: 5 },
    sourceEvent: { type: mongoose.Schema.Types.ObjectId, ref: 'OutboxEvent', default: null, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    resolvedAt: { type: Date, default: null, index: true }
  },
  { timestamps: true }
);

notificationSchema.index({ business: 1, notificationId: 1 }, { unique: true });
notificationSchema.index({ business: 1, resolvedAt: 1, priority: 1, sortDate: -1 });
notificationSchema.index({ business: 1, type: 1, resourceType: 1, resourceId: 1 });

const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);

export default Notification;
