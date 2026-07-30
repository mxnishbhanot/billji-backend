import mongoose from 'mongoose';

// One row per installed app instance. The FCM token is globally unique: when a device
// is handed to another user, or the same user switches business, re-registering moves
// the row rather than leaving a second one that would double-push.
const deviceTokenSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true, trim: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
    deviceName: { type: String, default: '', trim: true, maxlength: 120 },
    lastSeenAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

deviceTokenSchema.index({ business: 1, user: 1 });

const DeviceToken = mongoose.models.DeviceToken || mongoose.model('DeviceToken', deviceTokenSchema);

export default DeviceToken;
