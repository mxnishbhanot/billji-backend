import mongoose from 'mongoose';
import { entitlementsSchema, paise } from './Plan.js';

// Append-only billing forensics. Separate from AuditLog on purpose: AuditLog is per-business
// user activity shown inside the app, this answers "why did this customer lose access on the
// 3rd?" and feeds revenue reporting. User-visible transitions write to both.

export const SUBSCRIPTION_ACTIONS = [
  'created',
  'trial_started',
  'trial_ended',
  'activated',
  'renewed',
  'upgraded',
  'downgraded',
  'cancelled',
  'expired',
  'reactivated',
  'grace_entered',
  'resnapshot',
  'admin_override'
];

const subscriptionHistorySchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },
    action: { type: String, enum: SUBSCRIPTION_ACTIONS, required: true },
    fromPlanKey: { type: String, default: '', trim: true, maxlength: 60 },
    toPlanKey: { type: String, default: '', trim: true, maxlength: 60 },
    fromStatus: { type: String, default: '', trim: true, maxlength: 30 },
    toStatus: { type: String, default: '', trim: true, maxlength: 30 },
    effectiveAt: { type: Date, default: () => new Date() },
    amount: paise,
    currency: { type: String, default: 'INR', uppercase: true, trim: true, maxlength: 3 },
    // Both snapshots, so any past entitlement state can be reconstructed exactly — including
    // for a plan row that has since been edited or archived.
    snapshotBefore: { type: entitlementsSchema, default: null },
    snapshotAfter: { type: entitlementsSchema, default: null },
    actor: {
      type: { type: String, enum: ['user', 'system', 'admin', 'webhook'], default: 'system' },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      note: { type: String, default: '', trim: true, maxlength: 500 }
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

subscriptionHistorySchema.index({ business: 1, createdAt: -1 });
subscriptionHistorySchema.index({ action: 1, createdAt: -1 });

const SubscriptionHistory = mongoose.model('SubscriptionHistory', subscriptionHistorySchema);

export default SubscriptionHistory;
