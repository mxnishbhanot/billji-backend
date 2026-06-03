import mongoose from 'mongoose';

const userNotificationPreferenceSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Sparse overrides keyed by notification type, e.g. { 'low-stock': { inApp: false } }.
    // Absence of a type (or channel) means enabled, so new types default to on.
    preferences: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

userNotificationPreferenceSchema.index({ business: 1, user: 1 }, { unique: true });

const UserNotificationPreference =
  mongoose.models.UserNotificationPreference || mongoose.model('UserNotificationPreference', userNotificationPreferenceSchema);

export default UserNotificationPreference;
