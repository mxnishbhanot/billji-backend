import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import { domainStatusesForLegacy, legacyStatusFor } from '../models/SalesDocument.js';
import StockMovement from '../models/StockMovement.js';
import { env } from '../config/env.js';
import { resolvePlaceOfSupply, stateCodeFromGstin, stateCodeFromName, supplyTypeFor } from '../constants/gstStates.js';
import { ApiError } from '../utils/ApiError.js';
import { calculateInvoiceTotals } from '../utils/invoiceMath.js';
import { nextDocumentNumber } from './numberingService.js';
import { getDurableCachedInvoicePdfUrl } from './invoicePdfCache.js';
import crypto from 'crypto';

const LOCAL_PUBLIC_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const DEFAULT_SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const trimTrailingSlash = (value) => value.replace(/\/+$/, '');

const isLocalPublicUrl = (value) => {
  try {
    return LOCAL_PUBLIC_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

const requestBaseUrl = (req) => {
  const host = req?.get?.('host') || req?.headers?.host;
  if (!host) return trimTrailingSlash(env.apiPublicUrl);
  return `${req.protocol || 'http'}://${host}`;
};

export const buildPublicInvoicePdfUrl = (invoice, req) => {
  const configuredBaseUrl = trimTrailingSlash(env.apiPublicUrl);
  const baseUrl = isLocalPublicUrl(configuredBaseUrl) ? requestBaseUrl(req) : configuredBaseUrl;
  return `${trimTrailingSlash(baseUrl)}/api/public/invoices/${invoice._id}/${invoice.shareToken}/pdf`;
};

export const serializeInvoice = (invoice, req) => {
  const data = invoice.toObject ? invoice.toObject() : invoice;
  const paidAmount = data.paidAmount ?? (data.paymentStatus === 'paid' || data.paymentStatus === 'refunded' ? data.total : 0);
  // Money and credit are separate settlement figures: "Paid" means cash arrived.
  const creditApplied = data.creditApplied ?? 0;
  const balanceDue =
    data.balanceDue ?? Math.max(Number(data.total || 0) - Number(paidAmount || 0) - Number(creditApplied || 0), 0);

  const documentType = data.documentType || 'invoice';

  return {
    ...data,
    // Only invoices report an invoiceNumber. The fallback exists for legacy invoice rows
    // written before documentNumber; letting a quotation borrow it would make a quote look
    // like a tax invoice to every client that reads this field.
    ...(documentType === 'invoice' ? { invoiceNumber: invoice.invoiceNumber || invoice.documentNumber } : {}),
    status: invoice.status || legacyStatusFor(invoice),
    paidAmount,
    creditApplied,
    balanceDue,
    pdfUrl: buildPublicInvoicePdfUrl(invoice, req)
  };
};

export const generateInvoiceNumber = async (business, date = new Date(), { session } = {}) =>
  nextDocumentNumber({ business, documentType: 'invoice', date, session });

const addressSnapshotFrom = (source = {}, fallback = '') => ({
  line1: source.line1 || fallback || '',
  line2: source.line2 || '',
  city: source.city || '',
  state: source.state || '',
  pinCode: source.pinCode || source.pinCode === 0 ? String(source.pinCode) : '',
  country: source.country || 'India'
});

const taxIdentifiersFrom = (source = {}) => ({
  gstNumber: source.gstNumber || '',
  panNumber: source.panNumber || '',
  taxId: source.taxId || ''
});

/** Printed label for a customerless (counter/cash) sale. Not a Customer record. */
export const WALK_IN_CUSTOMER_NAME = 'Walk-in customer';

const customerSnapshotFrom = (source) => {
  const billingAddress = addressSnapshotFrom(source.billingAddress, source.address);
  const shippingAddress = addressSnapshotFrom(source.shippingAddress, source.address);
  const taxIdentifiers = taxIdentifiersFrom(source.taxIdentifiers);

  return {
    name: source.name,
    phone: source.phone,
    countryCode: source.countryCode || '+91',
    email: source.email || '',
    address: source.address || billingAddress.line1 || '',
    billingAddress,
    shippingAddress,
    gstNumber: source.gstNumber || taxIdentifiers.gstNumber || '',
    taxIdentifiers: {
      ...taxIdentifiers,
      gstNumber: taxIdentifiers.gstNumber || source.gstNumber || ''
    }
  };
};

export const buildCustomerSnapshot = async (businessId, payload, { session } = {}) => {
  if (payload.customerId) {
    const customer = await Customer.findOne({ _id: payload.customerId, business: businessId }).session(session || null);

    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }

    return {
      customerId: customer._id,
      snapshot: customerSnapshotFrom(customer)
    };
  }

  // A counter/cash sale: no customer was chosen and none was typed in. The document stays
  // genuinely customerless (customer: null, no Customer row is created) and only carries a
  // label so lists, PDFs and reports have something to print — matching the null-customer
  // bucket reportService already calls "Walk-in customer".
  if (!payload.customer) {
    return { customerId: null, snapshot: customerSnapshotFrom({ name: WALK_IN_CUSTOMER_NAME, phone: '' }) };
  }

  if (!payload.customer?.name || !payload.customer?.phone) {
    throw new ApiError(422, 'Customer name and phone are required');
  }

  return {
    customerId: null,
    snapshot: customerSnapshotFrom(payload.customer)
  };
};

/**
 * The rate this line should be taxed at, or undefined to inherit the document rate.
 *
 * `Product.taxRate` defaults to 0, so a stored 0 means "never configured" far more often
 * than it means "exempt" — treating it as an explicit 0% would silently drop tax to zero
 * on every existing product. An explicit rate in the request always wins, including 0,
 * which is how a genuinely exempt line is billed.
 */
const resolveItemTaxRate = (requested, productRate) => {
  if (requested !== undefined && requested !== null && requested !== '') return Number(requested);
  return Number(productRate) > 0 ? Number(productRate) : undefined;
};

export const normalizeItems = async (businessId, items, { allowOversell = false, session } = {}) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(422, 'At least one invoice item is required');
  }

  const normalized = [];
  const insufficientStock = [];
  const requestedByProduct = new Map();

  for (const item of items) {
    if (item.productId) {
      const product = await Product.findOne({ _id: item.productId, business: businessId }).session(session || null);

      if (!product) {
        throw new ApiError(404, `Product not found: ${item.productId}`);
      }

      const quantity = Number(item.quantity) || 1;
      const productId = String(product._id);
      const requested = requestedByProduct.get(productId) || { product, quantity: 0 };
      if (product.trackStock !== false) {
        requested.quantity += quantity;
        requestedByProduct.set(productId, requested);
      }

      normalized.push({
        product: product._id,
        name: product.name,
        sku: product.sku,
        hsn: item.hsn ?? product.hsn ?? '',
        unit: product.unit,
        quantity,
        price: item.price ?? product.price,
        purchasePrice: product.purchasePrice,
        taxRate: resolveItemTaxRate(item.taxRate, product.taxRate),
        isCustom: false
      });
    } else {
      normalized.push({
        product: null,
        name: item.name,
        sku: item.sku || '',
        hsn: item.hsn || '',
        unit: item.unit || 'pcs',
        quantity: item.quantity,
        price: item.price,
        // Custom lines have no product to inherit from; undefined means "use the
        // document rate", matching how custom items behaved before per-item GST.
        taxRate: resolveItemTaxRate(item.taxRate, 0),
        isCustom: true
      });
    }
  }

  if (!allowOversell) {
    requestedByProduct.forEach(({ product, quantity }) => {
      if (product.stockQuantity < quantity) {
        insufficientStock.push({
          productId: product._id,
          name: product.name,
          sku: product.sku,
          requested: quantity,
          available: product.stockQuantity,
          shortage: quantity - product.stockQuantity
        });
      }
    });
  }

  if (insufficientStock.length > 0) {
    throw new ApiError(409, 'Some products do not have enough app stock', {
      code: 'INSUFFICIENT_STOCK',
      items: insufficientStock
    });
  }

  return normalized;
};

/**
 * Where the supply is deemed to happen, and therefore whether it is CGST+SGST or IGST.
 * Shared by the invoice, order and preview paths so all three agree.
 */
export const resolveDocumentSupply = (business, snapshot, payload = {}) => {
  const supplierStateCode = business?.stateCode || stateCodeFromGstin(business?.gstNumber) || stateCodeFromName(business?.state);
  const placeOfSupply = resolvePlaceOfSupply({
    explicitCode: payload.placeOfSupplyCode,
    customerGstin: snapshot?.taxIdentifiers?.gstNumber || snapshot?.gstNumber,
    customerState: snapshot?.billingAddress?.state || snapshot?.shippingAddress?.state,
    supplierStateCode
  });

  return { supplierStateCode, placeOfSupply, supplyType: supplyTypeFor(supplierStateCode, placeOfSupply.code) };
};

/**
 * Builds a sales document of any type.
 *
 * `documentType` only affects identity here — the number series, and whether the legacy
 * `invoiceNumber` field is populated (invoices keep it for back-compat; other types leave
 * it unset so the unique index on it stays free). Stock, ledger and lifecycle effects are
 * the caller's business, driven by the per-type rules in modules/documents.
 */
export const buildSalesDocumentPayload = async (user, business, payload, { session, documentType = 'invoice' } = {}) => {
  const { customerId, snapshot } = await buildCustomerSnapshot(business._id, payload, { session });
  const items = await normalizeItems(business._id, payload.items, { allowOversell: Boolean(payload.allowOversell), session });
  const { placeOfSupply, supplyType } = resolveDocumentSupply(business, snapshot, payload);
  const totals = calculateInvoiceTotals({
    items,
    taxRate: payload.taxRate,
    discountType: payload.discountType,
    discountValue: payload.discountValue,
    supplyType,
    pricesIncludeTax: Boolean(business?.taxSettings?.pricesIncludeTax)
  });
  const date = payload.date ? new Date(payload.date) : new Date();
  const documentNumber =
    payload.invoiceNumber || payload.documentNumber || (await nextDocumentNumber({ business, documentType, date, session }));
  const domainStatuses = domainStatusesForLegacy(payload.status || 'pending');
  const isInvoice = documentType === 'invoice';

  return {
    business: business._id,
    createdBy: user._id,
    updatedBy: user._id,
    customer: customerId,
    documentType,
    documentNumber,
    // Only invoices carry invoiceNumber: it has a unique partial index, and a quotation
    // sharing the invoice series would collide with a real invoice.
    ...(isInvoice ? { invoiceNumber: documentNumber } : {}),
    date,
    dueDate: payload.dueDate || null,
    customerSnapshot: snapshot,
    items: totals.items,
    subtotal: totals.subtotal,
    tax: totals.tax,
    discount: totals.discount,
    placeOfSupply,
    supplyType,
    taxSummary: totals.taxSummary,
    total: totals.total,
    paidAmount: payload.status === 'paid' ? totals.total : 0,
    balanceDue: payload.status === 'paid' ? 0 : totals.total,
    documentStatus: domainStatuses.documentStatus,
    paymentStatus: domainStatuses.paymentStatus,
    fulfillmentStatus: 'pending',
    status: payload.status || 'pending',
    notes: payload.notes || '',
    // A quotation states how long the offer stands; other types ignore it.
    ...(payload.validUntil ? { validUntil: new Date(payload.validUntil) } : {}),
    ...(payload.sourceInvoice ? { sourceInvoice: payload.sourceInvoice } : {}),
    ...(payload.reason ? { reason: String(payload.reason).slice(0, 500) } : {}),
    shareToken: crypto.randomBytes(24).toString('hex'),
    shareExpiresAt: new Date(Date.now() + DEFAULT_SHARE_LINK_TTL_MS),
    pdfUrl: `${env.apiPublicUrl}/api/public/invoices/__pending__/pdf`
  };
};

/** Invoice-shaped wrapper kept so every existing caller reads unchanged. */
export const buildInvoicePayload = (user, business, payload, options = {}) =>
  buildSalesDocumentPayload(user, business, payload, { ...options, documentType: 'invoice' });

export const setInvoicePdfUrl = async (invoice, req, { session } = {}) => {
  invoice.pdfUrl = buildPublicInvoicePdfUrl(invoice, req);
  await invoice.save({ session });
  return invoice;
};

export const stockAdjustmentsForInvoice = async (invoice, direction = -1, { session, allowOversell = false } = {}) => {
  const productAdjustments = new Map();
  const movements = [];

  invoice.items
    .filter((item) => item.product)
    .forEach((item) => {
      const productId = String(item.product);
      const existing = productAdjustments.get(productId) || {
        product: item.product,
        name: item.name,
        quantity: 0
      };

      existing.quantity += Number(item.quantity) || 0;
      productAdjustments.set(productId, existing);
    });

  for (const adjustment of productAdjustments.values()) {
    const quantityChange = direction * adjustment.quantity;
    const stockFilter = { _id: adjustment.product, business: invoice.business, trackStock: { $ne: false } };
    if (direction < 0 && !allowOversell) {
      stockFilter.stockQuantity = { $gte: adjustment.quantity };
    }

    const product = await Product.findOneAndUpdate(
      stockFilter,
      { $inc: { stockQuantity: quantityChange } },
      { new: false, session }
    );

    if (!product) {
      const currentProduct = await Product.findOne({ _id: adjustment.product, business: invoice.business }).session(session || null);
      if (!currentProduct) {
        continue;
      }

      if (currentProduct.trackStock === false) {
        continue;
      }

      throw new ApiError(409, 'Some products do not have enough app stock', {
        code: 'INSUFFICIENT_STOCK',
        items: [{
          productId: currentProduct._id,
          name: currentProduct.name,
          sku: currentProduct.sku,
          requested: adjustment.quantity,
          available: currentProduct.stockQuantity,
          shortage: adjustment.quantity - currentProduct.stockQuantity
        }]
      });
    }

    const stockBefore = product.stockQuantity;
    const stockAfter = stockBefore + quantityChange;
    const type = direction > 0 ? 'sale_cancelled' : 'sale';

    const [movement] = await StockMovement.create([{
      business: invoice.business,
      createdBy: invoice.updatedBy || invoice.createdBy,
      product: product._id,
      salesDocument: invoice._id,
      documentType: invoice.documentType || 'invoice',
      documentNumber: invoice.documentNumber || invoice.invoiceNumber,
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      type,
      quantityChange,
      stockBefore,
      stockAfter,
      note:
        stockBefore < adjustment.quantity && direction < 0
          ? `Invoice ${invoice.invoiceNumber} sold more than app stock`
          : `Invoice ${invoice.invoiceNumber}`
    }], { session });
    movements.push({
      movementId: movement._id,
      productId: product._id,
      productName: product.name,
      stockBefore,
      stockAfter,
      quantityChange,
      lowStockThreshold: product.lowStockThreshold,
      documentId: invoice._id,
      documentNumber: invoice.documentNumber || invoice.invoiceNumber,
      documentType: invoice.documentType || 'invoice',
      movementType: type
    });
  }

  return movements;
};

export const getInvoiceForBusiness = async (businessId, invoiceId, { session } = {}) => {
  const invoice = await Invoice.findOne({ _id: invoiceId, business: businessId, documentType: 'invoice' }).session(session || null);

  if (!invoice) {
    throw new ApiError(404, 'Invoice not found');
  }

  return invoice;
};

// Best download URL for share messages: a durable direct-R2 link when one is
// configured, else the permanent API share URL (which itself serves from the
// R2 cache). Never a presigned URL — share messages outlive presigned TTLs.
export const resolveShareablePdfUrl = async (invoice, req) =>
  (await getDurableCachedInvoicePdfUrl(invoice)) || buildPublicInvoicePdfUrl(invoice, req);

export const buildInvoiceShareMessage = async (invoice, req) =>
  `Hello ${invoice.customerSnapshot.name}, your invoice is ready. Download here: ${await resolveShareablePdfUrl(invoice, req)}`;

export const buildWhatsAppLink = async (invoice, req) => {
  const phone = (invoice.customerSnapshot.phone || '').replace(/[^\d]/g, '');
  // A walk-in sale has no number to send to; a wa.me link without one goes nowhere.
  if (!phone) {
    throw new ApiError(422, 'This invoice has no customer phone number to share to');
  }
  const message = await buildInvoiceShareMessage(invoice, req);
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
};
