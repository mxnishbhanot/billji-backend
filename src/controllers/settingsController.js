import { settingsRules, updateSettings } from './authController.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildInvoiceHtml } from '../services/invoiceHtml.js';

export { settingsRules, updateSettings };

export const getSettings = asyncHandler(async (req, res) => {
  res.json({ success: true, settings: req.business });
});

// Representative invoice used to render the template preview. Fixed values keep the
// preview deterministic while the user tweaks the template.
const SAMPLE_INVOICE = {
  invoiceNumber: 'INV-0001',
  date: '2026-06-11T00:00:00.000Z',
  dueDate: null,
  paymentStatus: 'partial',
  customerSnapshot: {
    name: 'Acme Corp',
    phone: '+91 90000 12345',
    email: 'accounts@acme.com',
    billingAddress: { line1: '42 MG Road', city: 'Bengaluru', state: 'KA', pinCode: '560001' },
    gstNumber: '29ABCDE1234F1Z5'
  },
  items: [
    { name: 'Design consultation', quantity: 2, price: 1500, total: 3000 },
    { name: 'Premium hosting (1 yr)', sku: 'HOST-PRO', quantity: 1, price: 4200, total: 4200 }
  ],
  subtotal: 7200,
  tax: { rate: 18, amount: 1296 },
  discount: { amount: 0 },
  total: 8496,
  paidAmount: 4032,
  balanceDue: 4464,
  // Left blank so the preview shows the business's saved notes (or the default),
  // letting the user see exactly what their custom notes will look like.
  notes: ''
};

// Returns the live invoice HTML (same template the PDF uses) for the mobile WebView
// preview. The body carries the in-progress, unsaved template so toggling updates instantly.
export const invoiceTemplatePreview = asyncHandler(async (req, res) => {
  const business = typeof req.business?.toObject === 'function' ? req.business.toObject() : { ...(req.business || {}) };
  business.invoiceTemplate = { ...(business.invoiceTemplate || {}), ...(req.body || {}) };

  const html = buildInvoiceHtml(SAMPLE_INVOICE, business, { mode: 'screen' });
  res.type('html').send(html);
});
