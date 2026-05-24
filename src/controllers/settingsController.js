import { settingsRules, updateSettings } from './authController.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export { settingsRules, updateSettings };

export const getSettings = asyncHandler(async (req, res) => {
  res.json({ success: true, settings: req.user.businessProfile });
});
