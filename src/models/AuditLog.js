import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null, index: true },
    action: { type: String, required: true, trim: true, maxlength: 120, index: true },
    resourceType: { type: String, default: '', trim: true, maxlength: 80, index: true },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    ipAddress: { type: String, default: '', trim: true, maxlength: 80 },
    userAgent: { type: String, default: '', trim: true, maxlength: 500 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

auditLogSchema.index({ business: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ user: 1, createdAt: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1, createdAt: -1 });

const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);

export default AuditLog;
