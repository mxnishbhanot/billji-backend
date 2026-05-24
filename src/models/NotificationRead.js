import mongoose from 'mongoose';

const notificationReadSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    notificationId: { type: String, required: true, maxlength: 180 }
  },
  { timestamps: true }
);

notificationReadSchema.index({ user: 1, notificationId: 1 }, { unique: true });

const NotificationRead = mongoose.model('NotificationRead', notificationReadSchema);

export default NotificationRead;
