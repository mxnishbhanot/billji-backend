import mongoose from 'mongoose';

const itemStatusSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['pending', 'completed', 'skipped'], default: 'pending' },
    completedAt: { type: Date, default: null },
    method: { type: String, enum: ['action', 'detected', 'skipped', null], default: null }
  },
  { _id: false }
);

const tipStatusSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['pending', 'seen', 'completed', 'dismissed', 'snoozed'], default: 'pending' },
    seenAt: { type: Date, default: null },
    dismissedAt: { type: Date, default: null },
    snoozedUntil: { type: Date, default: null }
  },
  { _id: false }
);

const onboardingProgressSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    roleKeyAtStart: { type: String, default: '', trim: true, maxlength: 40 },
    orientation: {
      tourId: { type: String, default: 'orientation-v1', trim: true, maxlength: 80 },
      version: { type: Number, default: 1 },
      status: { type: String, enum: ['pending', 'in_progress', 'completed', 'dismissed'], default: 'pending' },
      currentStep: { type: String, default: '', trim: true, maxlength: 80 },
      completedAt: { type: Date, default: null },
      dismissedAt: { type: Date, default: null }
    },
    checklist: {
      status: { type: String, enum: ['active', 'completed', 'dismissed'], default: 'active' },
      dismissedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      items: { type: Map, of: itemStatusSchema, default: () => new Map() }
    },
    tips: { type: Map, of: tipStatusSchema, default: () => new Map() }
  },
  { timestamps: true }
);

onboardingProgressSchema.index({ business: 1, user: 1 }, { unique: true });

const OnboardingProgress =
  mongoose.models.OnboardingProgress || mongoose.model('OnboardingProgress', onboardingProgressSchema);

export default OnboardingProgress;
