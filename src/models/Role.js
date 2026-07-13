import mongoose from 'mongoose';

const roleSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, index: true },
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 240 },
    permissions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Permission' }],
    isSystem: { type: Boolean, default: false, index: true },
    // Reserved for future role inheritance (design only; no resolution logic yet).
    inheritsFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },
    // Versioning + soft-delete. Roles are archived, never hard-deleted while referenced,
    // so historical audit logs stay valid.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

roleSchema.index({ business: 1, key: 1 }, { unique: true });

const Role = mongoose.model('Role', roleSchema);

export default Role;
