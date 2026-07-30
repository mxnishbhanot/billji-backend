import mongoose from 'mongoose';

// One row per scheduled job. The row IS the lock: a job is claimed with a single
// atomic findOneAndUpdate whose filter requires the previous run to be old enough,
// so two API instances can never run the same job in the same window.
const scheduledJobRunSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    lastRunAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    runs: { type: Number, default: 0 }
  },
  { timestamps: true }
);

const ScheduledJobRun =
  mongoose.models.ScheduledJobRun || mongoose.model('ScheduledJobRun', scheduledJobRunSchema);

export default ScheduledJobRun;
