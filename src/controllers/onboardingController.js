import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js';
import OnboardingProgress from '../models/OnboardingProgress.js';
import Payment from '../models/Payment.js';
import Product from '../models/Product.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

const ORIENTATION_STATUSES = new Set(['pending', 'in_progress', 'completed', 'dismissed']);
const CHECKLIST_STATUSES = new Set(['active', 'completed', 'dismissed']);
const ITEM_STATUSES = new Set(['pending', 'completed', 'skipped']);
const ITEM_METHODS = new Set(['action', 'detected', 'skipped']);
const TIP_STATUSES = new Set(['pending', 'seen', 'completed', 'dismissed', 'snoozed']);

const isProfileComplete = (business) => {
  const name = String(business.businessName || '').trim();
  const address = String(business.address || '').trim();
  const phone = String(business.phone || '').trim();
  const looksDefault = /'s Business$/i.test(name);
  return Boolean(name && !looksDefault && address && phone);
};

const isTaxConfigured = (business) => {
  const rate = Number(business.taxSettings?.defaultRate || 0);
  const gst = String(business.gstNumber || '').trim();
  return rate > 0 || Boolean(gst);
};

const mapToObject = (mapLike) => {
  if (!mapLike) return {};
  if (mapLike instanceof Map) return Object.fromEntries(mapLike.entries());
  if (typeof mapLike === 'object') return { ...mapLike };
  return {};
};

const serializeProgress = (doc) => ({
  id: String(doc._id),
  roleKeyAtStart: doc.roleKeyAtStart || '',
  orientation: {
    tourId: doc.orientation?.tourId || 'orientation-v1',
    version: doc.orientation?.version ?? 1,
    status: doc.orientation?.status || 'pending',
    currentStep: doc.orientation?.currentStep || '',
    completedAt: doc.orientation?.completedAt || null,
    dismissedAt: doc.orientation?.dismissedAt || null
  },
  checklist: {
    status: doc.checklist?.status || 'active',
    dismissedAt: doc.checklist?.dismissedAt || null,
    completedAt: doc.checklist?.completedAt || null,
    items: mapToObject(doc.checklist?.items)
  },
  tips: mapToObject(doc.tips),
  updatedAt: doc.updatedAt
});

const buildHints = async (business) => {
  const businessId = business._id;
  const [customerCount, productCount, invoiceCount, paymentCount] = await Promise.all([
    Customer.countDocuments({ business: businessId }),
    Product.countDocuments({ business: businessId }),
    Invoice.countDocuments({ business: businessId, documentType: 'invoice' }),
    Payment.countDocuments({ business: businessId })
  ]);

  return {
    profileComplete: isProfileComplete(business),
    taxConfigured: isTaxConfigured(business),
    customerCount,
    productCount,
    invoiceCount,
    paymentCount,
    hasInvoices: invoiceCount > 0,
    // Invitees joining a busy workspace should skip orientation.
    skipOrientation: invoiceCount > 0
  };
};

const getOrCreateProgress = async (userId, businessId, roleKey) => {
  let doc = await OnboardingProgress.findOne({ user: userId, business: businessId });
  if (doc) return doc;

  doc = await OnboardingProgress.create({
    user: userId,
    business: businessId,
    roleKeyAtStart: roleKey || ''
  });
  return doc;
};

export const getOnboardingProgress = asyncHandler(async (req, res) => {
  const roleKey = req.membership?.roleKey || req.user?.roleKey || '';
  const [doc, hints] = await Promise.all([
    getOrCreateProgress(req.user._id, req.business._id, roleKey),
    buildHints(req.business)
  ]);

  res.json({
    success: true,
    progress: serializeProgress(doc),
    hints
  });
});

export const patchOnboardingProgress = asyncHandler(async (req, res) => {
  const roleKey = req.membership?.roleKey || req.user?.roleKey || '';
  const doc = await getOrCreateProgress(req.user._id, req.business._id, roleKey);
  const { orientation, checklist, tips } = req.body || {};

  if (orientation && typeof orientation === 'object') {
    if (orientation.tourId != null) doc.orientation.tourId = String(orientation.tourId).slice(0, 80);
    if (orientation.version != null) doc.orientation.version = Number(orientation.version) || 1;
    if (orientation.status != null) {
      if (!ORIENTATION_STATUSES.has(orientation.status)) throw new ApiError(400, 'Invalid orientation status');
      doc.orientation.status = orientation.status;
      if (orientation.status === 'completed' && !doc.orientation.completedAt) {
        doc.orientation.completedAt = new Date();
      }
      if (orientation.status === 'dismissed' && !doc.orientation.dismissedAt) {
        doc.orientation.dismissedAt = new Date();
      }
    }
    if (orientation.currentStep != null) doc.orientation.currentStep = String(orientation.currentStep).slice(0, 80);
  }

  if (checklist && typeof checklist === 'object') {
    if (checklist.status != null) {
      if (!CHECKLIST_STATUSES.has(checklist.status)) throw new ApiError(400, 'Invalid checklist status');
      doc.checklist.status = checklist.status;
      if (checklist.status === 'dismissed' && !doc.checklist.dismissedAt) {
        doc.checklist.dismissedAt = new Date();
      }
      if (checklist.status === 'completed' && !doc.checklist.completedAt) {
        doc.checklist.completedAt = new Date();
      }
      if (checklist.status === 'active') {
        doc.checklist.dismissedAt = null;
      }
    }

    if (checklist.items && typeof checklist.items === 'object') {
      for (const [taskKey, raw] of Object.entries(checklist.items)) {
        if (!raw || typeof raw !== 'object') continue;
        const key = String(taskKey).slice(0, 80);
        const existing = doc.checklist.items.get(key) || { status: 'pending', completedAt: null, method: null };
        const next = { ...existing };

        if (raw.status != null) {
          if (!ITEM_STATUSES.has(raw.status)) throw new ApiError(400, `Invalid item status for ${key}`);
          next.status = raw.status;
          if (raw.status === 'completed' || raw.status === 'skipped') {
            next.completedAt = raw.completedAt ? new Date(raw.completedAt) : new Date();
          }
          if (raw.status === 'pending') {
            next.completedAt = null;
            next.method = null;
          }
        }
        if (raw.method != null) {
          if (!ITEM_METHODS.has(raw.method)) throw new ApiError(400, `Invalid item method for ${key}`);
          next.method = raw.method;
        }
        doc.checklist.items.set(key, next);
      }
    }
  }

  if (tips && typeof tips === 'object') {
    for (const [tipId, raw] of Object.entries(tips)) {
      if (!raw || typeof raw !== 'object') continue;
      const key = String(tipId).slice(0, 80);
      const existing = doc.tips.get(key) || {
        status: 'pending',
        seenAt: null,
        dismissedAt: null,
        snoozedUntil: null
      };
      const next = { ...existing };

      if (raw.status != null) {
        if (!TIP_STATUSES.has(raw.status)) throw new ApiError(400, `Invalid tip status for ${key}`);
        next.status = raw.status;
        if (raw.status === 'seen' || raw.status === 'completed') {
          next.seenAt = raw.seenAt ? new Date(raw.seenAt) : new Date();
        }
        if (raw.status === 'dismissed') {
          next.dismissedAt = raw.dismissedAt ? new Date(raw.dismissedAt) : new Date();
        }
        if (raw.status === 'snoozed' && raw.snoozedUntil) {
          next.snoozedUntil = new Date(raw.snoozedUntil);
        }
      }
      doc.tips.set(key, next);
    }
  }

  await doc.save();
  const hints = await buildHints(req.business);

  res.json({
    success: true,
    progress: serializeProgress(doc),
    hints
  });
});

export const replayOnboarding = asyncHandler(async (req, res) => {
  const roleKey = req.membership?.roleKey || req.user?.roleKey || '';
  const doc = await getOrCreateProgress(req.user._id, req.business._id, roleKey);
  const { orientation = true, checklist = false, resetChecklist = false, tipIds = [] } = req.body || {};

  if (orientation) {
    doc.orientation.status = 'pending';
    doc.orientation.currentStep = '';
    doc.orientation.completedAt = null;
    doc.orientation.dismissedAt = null;
  }

  if (checklist) {
    doc.checklist.status = 'active';
    doc.checklist.dismissedAt = null;
    doc.checklist.completedAt = null;
  }

  if (resetChecklist) {
    doc.checklist.items = new Map();
    doc.checklist.status = 'active';
    doc.checklist.dismissedAt = null;
    doc.checklist.completedAt = null;
  }

  if (Array.isArray(tipIds)) {
    for (const tipId of tipIds) {
      const key = String(tipId).slice(0, 80);
      doc.tips.set(key, {
        status: 'pending',
        seenAt: null,
        dismissedAt: null,
        snoozedUntil: null
      });
    }
  }

  await doc.save();
  const hints = await buildHints(req.business);

  res.json({
    success: true,
    progress: serializeProgress(doc),
    hints
  });
});
