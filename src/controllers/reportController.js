import { asyncHandler } from '../utils/asyncHandler.js';
import { getReportSummary } from '../services/reportService.js';

export const summary = asyncHandler(async (req, res) => {
  const report = await getReportSummary(req.user._id);
  res.json({ success: true, report });
});
