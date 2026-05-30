import mongoose from 'mongoose';

const permissionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 80, unique: true },
    domain: { type: String, required: true, trim: true, maxlength: 60, index: true },
    description: { type: String, default: '', trim: true, maxlength: 240 }
  },
  { timestamps: true }
);

const Permission = mongoose.model('Permission', permissionSchema);

export default Permission;
