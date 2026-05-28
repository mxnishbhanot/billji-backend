import mongoose from 'mongoose';

const businessMemberSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    roleKey: {
      type: String,
      enum: ['owner', 'admin', 'accountant', 'staff', 'viewer'],
      default: 'owner',
      index: true
    },
    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },
    status: { type: String, enum: ['active', 'invited', 'disabled'], default: 'active', index: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    joinedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

businessMemberSchema.index({ business: 1, user: 1 }, { unique: true });
businessMemberSchema.index({ user: 1, status: 1 });

const BusinessMember = mongoose.model('BusinessMember', businessMemberSchema);

export default BusinessMember;
