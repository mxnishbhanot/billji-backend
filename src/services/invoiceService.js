import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import StockMovement from '../models/StockMovement.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { calculateInvoiceTotals } from '../utils/invoiceMath.js';
import crypto from 'crypto';

const LOCAL_PUBLIC_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

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

export const serializeInvoice = (invoice, req) => ({
  ...(invoice.toObject ? invoice.toObject() : invoice),
  pdfUrl: buildPublicInvoicePdfUrl(invoice, req)
});

export const generateInvoiceNumber = async (user, date = new Date()) => {
  const prefix = user.businessProfile?.invoicePrefix || 'INV';
  const year = date.getFullYear();
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const count = await Invoice.countDocuments({ user: user._id, createdAt: { $gte: start, $lt: end } });
  return `${prefix}-${year}-${String(count + 1).padStart(4, '0')}`;
};

export const buildCustomerSnapshot = async (userId, payload) => {
  if (payload.customerId) {
    const customer = await Customer.findOne({ _id: payload.customerId, user: userId });

    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }

    return {
      customerId: customer._id,
      snapshot: {
        name: customer.name,
        phone: customer.phone,
        countryCode: customer.countryCode || '+91',
        email: customer.email,
        address: customer.address
      }
    };
  }

  if (!payload.customer?.name || !payload.customer?.phone) {
    throw new ApiError(422, 'Customer name and phone are required');
  }

  return {
    customerId: null,
    snapshot: {
      name: payload.customer.name,
      phone: payload.customer.phone,
      countryCode: payload.customer.countryCode || '+91',
      email: payload.customer.email || '',
      address: payload.customer.address || ''
    }
  };
};

export const normalizeItems = async (userId, items, { allowOversell = false } = {}) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(422, 'At least one invoice item is required');
  }

  const normalized = [];
  const insufficientStock = [];
  const requestedByProduct = new Map();

  for (const item of items) {
    if (item.productId) {
      const product = await Product.findOne({ _id: item.productId, user: userId });

      if (!product) {
        throw new ApiError(404, `Product not found: ${item.productId}`);
      }

      const quantity = Number(item.quantity) || 1;
      const productId = String(product._id);
      const requested = requestedByProduct.get(productId) || { product, quantity: 0 };
      requested.quantity += quantity;
      requestedByProduct.set(productId, requested);

      normalized.push({
        product: product._id,
        name: product.name,
        sku: product.sku,
        quantity,
        price: item.price ?? product.price,
        isCustom: false
      });
    } else {
      normalized.push({
        product: null,
        name: item.name,
        sku: item.sku || '',
        quantity: item.quantity,
        price: item.price,
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

export const buildInvoicePayload = async (user, payload) => {
  const { customerId, snapshot } = await buildCustomerSnapshot(user._id, payload);
  const items = await normalizeItems(user._id, payload.items, { allowOversell: Boolean(payload.allowOversell) });
  const totals = calculateInvoiceTotals({
    items,
    taxRate: payload.taxRate,
    discountType: payload.discountType,
    discountValue: payload.discountValue
  });
  const date = payload.date ? new Date(payload.date) : new Date();
  const invoiceNumber = payload.invoiceNumber || (await generateInvoiceNumber(user, date));

  return {
    user: user._id,
    customer: customerId,
    invoiceNumber,
    date,
    dueDate: payload.dueDate || null,
    customerSnapshot: snapshot,
    items: totals.items,
    subtotal: totals.subtotal,
    tax: totals.tax,
    discount: totals.discount,
    total: totals.total,
    status: payload.status || 'pending',
    notes: payload.notes || '',
    shareToken: crypto.randomBytes(24).toString('hex'),
    pdfUrl: `${env.apiPublicUrl}/api/public/invoices/__pending__/pdf`
  };
};

export const setInvoicePdfUrl = async (invoice, req) => {
  invoice.pdfUrl = buildPublicInvoicePdfUrl(invoice, req);
  await invoice.save();
  return invoice;
};

export const stockAdjustmentsForInvoice = async (invoice, direction = -1) => {
  const productAdjustments = new Map();

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
    const product = await Product.findOneAndUpdate(
      { _id: adjustment.product, user: invoice.user },
      { $inc: { stockQuantity: quantityChange } },
      { new: false }
    );

    if (!product) {
      continue;
    }

    const stockBefore = product.stockQuantity;
    const stockAfter = stockBefore + quantityChange;
    const type =
      direction > 0
        ? 'invoice_deleted'
        : stockBefore < adjustment.quantity
          ? 'oversell'
          : 'sale';

    await StockMovement.create({
      user: invoice.user,
      product: product._id,
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      type,
      quantityChange,
      stockBefore,
      stockAfter,
      note:
        type === 'oversell'
          ? `Invoice ${invoice.invoiceNumber} sold more than app stock`
          : `Invoice ${invoice.invoiceNumber}`
    });
  }
};

export const getInvoiceForUser = async (userId, invoiceId) => {
  const invoice = await Invoice.findOne({ _id: invoiceId, user: userId });

  if (!invoice) {
    throw new ApiError(404, 'Invoice not found');
  }

  return invoice;
};

export const buildInvoiceShareMessage = (invoice, req) =>
  `Hello ${invoice.customerSnapshot.name}, your invoice is ready. Download here: ${buildPublicInvoicePdfUrl(invoice, req)}`;

export const buildWhatsAppLink = (invoice, req) => {
  const countryCode = (invoice.customerSnapshot.countryCode || '+91').replace('+', '');
  const phone = invoice.customerSnapshot.phone.replace(/[^\d]/g, '');
  const message = buildInvoiceShareMessage(invoice, req);
  return `https://wa.me/${countryCode}${phone}?text=${encodeURIComponent(message)}`;
};
