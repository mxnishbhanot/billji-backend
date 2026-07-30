import { query } from 'express-validator';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { logAudit } from '../../services/auditService.js';
import { GSTR1_SECTION_KEYS, gstr1SectionCsv, gstr3bCsv } from './csvSections.js';
import { buildGstr1, buildGstr3b } from './service.js';

export const returnQueryRules = [
  query('period').trim().matches(/^\d{4}-\d{2}$/).withMessage('Period must be in YYYY-MM format'),
  query('format').optional({ checkFalsy: true }).isIn(['json', 'csv']),
  query('section').optional({ checkFalsy: true }).isIn(GSTR1_SECTION_KEYS)
];

const fileNameFor = (business, kind, period, section) => {
  const gstin = (business.gstNumber || 'gstin').toUpperCase();
  return [gstin, kind, period, section].filter(Boolean).join('-').concat('.csv');
};

const sendCsv = (res, fileName, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(csv);
};

export const getGstr1 = asyncHandler(async (req, res) => {
  const report = await buildGstr1(req.business, req.query.period);

  if (req.query.format === 'csv') {
    // One section per download: each GSTR-1 section has its own column layout, and the
    // offline tool takes them as separate sheets anyway.
    const section = req.query.section;
    if (!section) throw new ApiError(422, 'Choose a section to download as CSV');

    void logAudit(req, {
      action: 'gst.gstr1_downloaded',
      resourceType: 'business',
      resourceId: req.business._id,
      metadata: { period: report.period, section }
    });
    return sendCsv(res, fileNameFor(req.business, 'GSTR1', report.period, section), gstr1SectionCsv(report, section));
  }

  res.json({ success: true, report });
});

export const getGstr3b = asyncHandler(async (req, res) => {
  const report = await buildGstr3b(req.business, req.query.period);

  if (req.query.format === 'csv') {
    void logAudit(req, {
      action: 'gst.gstr3b_downloaded',
      resourceType: 'business',
      resourceId: req.business._id,
      metadata: { period: report.period }
    });
    return sendCsv(res, fileNameFor(req.business, 'GSTR3B', report.period), gstr3bCsv(report));
  }

  res.json({ success: true, report });
});
