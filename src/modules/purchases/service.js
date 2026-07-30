import LedgerEntry from '../../models/LedgerEntry.js';
import Payment from '../../models/Payment.js';
import Product from '../../models/Product.js';
import PurchaseBill from '../../models/PurchaseBill.js';
import StockMovement from '../../models/StockMovement.js';
import Vendor from '../../models/Vendor.js';
import { resolvePlaceOfSupply, stateCodeFromGstin, stateCodeFromName, supplyTypeFor } from '../../constants/gstStates.js';
import { ApiError } from '../../utils/ApiError.js';
import { calculateInvoiceTotals } from '../../utils/invoiceMath.js';
import { nextDocumentNumber } from '../../services/numberingService.js';
import { withTransaction } from '../../utils/transaction.js';
import { createLedgerEntries } from '../payments/repository.js';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

const fundingAccountFor = (paymentMethod) => (paymentMethod === 'cash' ? 'cash' : 'bank');

export const getVendorForBusiness = async (businessId, vendorId, { session } = {}) => {
  const vendor = await Vendor.findOne({ _id: vendorId, business: businessId }).session(session || null);
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  return vendor;
};

export const getPurchaseForBusiness = async (businessId, billId, { session } = {}) => {
  const bill = await PurchaseBill.findOne({ _id: billId, business: businessId }).session(session || null);
  if (!bill) throw new ApiError(404, 'Purchase bill not found');
  return bill;
};

/**
 * What this vendor is still owed, recomputed from source rather than incremented.
 * Cancelled bills drop out; vendor payments come off the top.
 */
export const vendorPayableTotals = async (businessId, vendorId, { session } = {}) => {
  const [billTotals, paidTotals] = await Promise.all([
    PurchaseBill.aggregate([
      { $match: { business: businessId, vendor: vendorId, status: 'received' } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]).session(session || null),
    Payment.aggregate([
      { $match: { business: businessId, vendor: vendorId, type: 'vendor_payment', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).session(session || null)
  ]);

  const billed = money(billTotals[0]?.total || 0);
  const paid = money(paidTotals[0]?.total || 0);

  return { billed, paid, outstandingPayable: money(Math.max(billed - paid, 0)) };
};

export const refreshVendorPayable = async (businessId, vendorId, { session, actorId } = {}) => {
  const totals = await vendorPayableTotals(businessId, vendorId, { session });
  await Vendor.updateOne(
    { _id: vendorId, business: businessId },
    { $set: { outstandingPayable: totals.outstandingPayable, updatedBy: actorId || null } },
    { session }
  );
  return totals;
};

/**
 * Stock in (direction +1) or back out (-1) for every tracked line on a bill.
 *
 * Deliberately not shared with stockAdjustmentsForInvoice: that one guards against
 * overselling and reads sales-document fields. Receiving goods can never be short, so the
 * guard would be noise, and the movement references a purchase bill rather than an invoice.
 */
const stockMovementsForPurchase = async (bill, direction, { session, actorId } = {}) => {
  const byProduct = new Map();

  for (const item of bill.items) {
    if (!item.product) continue;
    const key = String(item.product);
    const existing = byProduct.get(key) || { product: item.product, name: item.name, quantity: 0, price: item.price };
    existing.quantity += Number(item.quantity) || 0;
    byProduct.set(key, existing);
  }

  const movements = [];

  for (const line of byProduct.values()) {
    const quantityChange = direction * line.quantity;
    const product = await Product.findOneAndUpdate(
      { _id: line.product, business: bill.business, trackStock: { $ne: false } },
      { $inc: { stockQuantity: quantityChange } },
      { new: false, session }
    );

    // Untracked products (services, non-inventory) simply have no movement.
    if (!product) continue;

    const stockBefore = product.stockQuantity;
    const [movement] = await StockMovement.create(
      [
        {
          business: bill.business,
          createdBy: actorId,
          product: product._id,
          documentType: 'purchase',
          documentNumber: bill.billNumber,
          type: direction > 0 ? 'purchase' : 'stock_correction',
          quantityChange,
          stockBefore,
          stockAfter: stockBefore + quantityChange,
          note: direction > 0 ? `Purchase ${bill.billNumber}` : `Purchase ${bill.billNumber} cancelled`
        }
      ],
      { session }
    );

    movements.push({ movementId: movement._id, productId: product._id, quantityChange });
  }

  return movements;
};

/**
 * Receiving stock updates what it costs us. Without this, margin keeps using the price
 * from whenever the product was first created, and every report drifts.
 */
const syncPurchasePrices = async (bill, { session }) => {
  for (const item of bill.items) {
    if (!item.product || !(Number(item.price) > 0)) continue;
    await Product.updateOne({ _id: item.product, business: bill.business }, { $set: { purchasePrice: money(item.price) } }, { session });
  }
};

const purchaseLedgerEntries = (bill, actorId) => {
  const shared = {
    business: bill.business,
    sourceType: 'purchase',
    sourceId: bill._id,
    currency: 'INR',
    entryDate: bill.date || new Date(),
    createdBy: actorId
  };
  const label = `Purchase ${bill.billNumber} — ${bill.vendorSnapshot?.name || 'vendor'}`;

  // Goods in, money owed out. Buying on credit does not touch cash until it is paid.
  return [
    { ...shared, account: 'inventory', direction: 'debit', amount: money(bill.total), description: label },
    { ...shared, account: 'accounts_payable', direction: 'credit', amount: money(bill.total), description: `${label} (payable)` }
  ];
};

const buildBillPayload = async (req, vendor, { session }) => {
  const body = req.body;
  const business = req.business;

  const items = (body.items || []).map((item) => ({
    product: item.productId || null,
    name: item.name,
    sku: item.sku || '',
    hsn: item.hsn || '',
    unit: item.unit || 'pcs',
    quantity: Number(item.quantity) || 1,
    price: Number(item.price) || 0,
    taxRate: item.taxRate,
    isCustom: !item.productId
  }));

  if (!items.length) throw new ApiError(422, 'A purchase bill needs at least one item');

  // A purchase is an inward supply: place of supply is the vendor's state, and the
  // intra/inter split follows the same rule as sales.
  const supplierStateCode = business?.stateCode || stateCodeFromGstin(business?.gstNumber) || stateCodeFromName(business?.state);
  const placeOfSupply = resolvePlaceOfSupply({
    explicitCode: body.placeOfSupplyCode,
    customerGstin: vendor.gstNumber,
    supplierStateCode
  });
  const supplyType = supplyTypeFor(supplierStateCode, placeOfSupply.code);

  const totals = calculateInvoiceTotals({
    items,
    taxRate: body.taxRate,
    discountType: body.discountType,
    discountValue: body.discountValue,
    supplyType
  });

  const date = body.date ? new Date(body.date) : new Date();
  const billNumber = await nextDocumentNumber({ business, documentType: 'purchase', date, session });

  return {
    business: business._id,
    createdBy: req.user._id,
    updatedBy: req.user._id,
    vendor: vendor._id,
    vendorSnapshot: { name: vendor.name, phone: vendor.phone || '', gstNumber: vendor.gstNumber || '' },
    billNumber,
    vendorBillNumber: body.vendorBillNumber || '',
    date,
    dueDate: body.dueDate ? new Date(body.dueDate) : null,
    items: totals.items,
    subtotal: totals.subtotal,
    taxTotal: totals.tax.amount,
    cgstTotal: totals.cgstTotal,
    sgstTotal: totals.sgstTotal,
    igstTotal: totals.igstTotal,
    discount: totals.discount,
    total: totals.total,
    paidAmount: 0,
    balanceDue: totals.total,
    supplyType,
    placeOfSupply,
    status: 'received',
    paymentStatus: 'unpaid',
    notes: body.notes || ''
  };
};

export const createPurchaseWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const vendor = await getVendorForBusiness(req.business._id, req.body.vendorId, { session });
    const payload = await buildBillPayload(req, vendor, { session });

    const [bill] = await PurchaseBill.create([payload], { session });

    await stockMovementsForPurchase(bill, 1, { session, actorId: req.user._id });
    await syncPurchasePrices(bill, { session });
    await createLedgerEntries(purchaseLedgerEntries(bill, req.user._id), { session });
    await refreshVendorPayable(req.business._id, vendor._id, { session, actorId: req.user._id });

    return bill;
  });

/**
 * Cancel reverses everything the bill did: stock back out, compensating ledger entries,
 * payable recomputed. Blocked once money has been paid against it — unwinding a settled
 * bill would leave a payment pointing at nothing.
 */
export const cancelPurchaseWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const bill = await getPurchaseForBusiness(req.business._id, req.params.id, { session });
    if (bill.status === 'cancelled') return bill;

    if (Number(bill.paidAmount) > 0) {
      throw new ApiError(409, 'This bill has payments recorded against it. Reverse the payments first.', {
        code: 'PURCHASE_HAS_PAYMENTS',
        paidAmount: bill.paidAmount
      });
    }

    const originals = await LedgerEntry.find({ business: req.business._id, sourceType: 'purchase', sourceId: bill._id })
      .session(session)
      .lean();

    if (originals.length) {
      const reversedAt = new Date();
      await createLedgerEntries(
        originals.map((entry) => ({
          business: entry.business,
          sourceType: 'adjustment',
          sourceId: bill._id,
          account: entry.account,
          direction: entry.direction === 'debit' ? 'credit' : 'debit',
          amount: entry.amount,
          currency: entry.currency,
          entryDate: reversedAt,
          description: `Reversal (purchase ${bill.billNumber} cancelled): ${entry.description}`,
          createdBy: req.user._id,
          metadata: { reversalOf: entry._id }
        })),
        { session }
      );
    }

    await stockMovementsForPurchase(bill, -1, { session, actorId: req.user._id });

    bill.status = 'cancelled';
    bill.cancelledAt = new Date();
    bill.cancelledBy = req.user._id;
    bill.updatedBy = req.user._id;
    if (typeof req.body?.cancelReason === 'string') bill.cancelReason = req.body.cancelReason.trim().slice(0, 500);
    await bill.save({ session });

    await refreshVendorPayable(req.business._id, bill.vendor, { session, actorId: req.user._id });

    return bill;
  });

/**
 * Pays a vendor, optionally against one bill.
 *
 * Reuses the Payment collection with type 'vendor_payment' rather than a parallel model —
 * the shape (amount, method, reference, receivedAt) is identical, and one payments table
 * keeps the ledger and cash position in one place.
 */
export const recordVendorPaymentWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const vendor = await getVendorForBusiness(req.business._id, req.params.id, { session });
    const amount = money(req.body.amount);

    if (!(amount > 0)) throw new ApiError(422, 'Payment amount must be greater than zero');

    const bill = req.body.billId ? await getPurchaseForBusiness(req.business._id, req.body.billId, { session }) : null;

    if (bill) {
      if (String(bill.vendor) !== String(vendor._id)) {
        throw new ApiError(422, 'That bill belongs to a different vendor');
      }
      if (bill.status === 'cancelled') {
        throw new ApiError(409, 'A cancelled bill cannot be paid', { code: 'PURCHASE_CANCELLED' });
      }
      if (amount > money(bill.balanceDue)) {
        throw new ApiError(422, `Payment exceeds the outstanding ${bill.balanceDue} on this bill`, {
          code: 'PAYMENT_EXCEEDS_BILL',
          balanceDue: bill.balanceDue
        });
      }
    }

    const method = req.body.method || 'cash';
    const [payment] = await Payment.create(
      [
        {
          business: req.business._id,
          vendor: vendor._id,
          purchaseBill: bill?._id || null,
          createdBy: req.user._id,
          updatedBy: req.user._id,
          type: 'vendor_payment',
          method,
          status: 'completed',
          amount,
          reference: req.body.reference || '',
          notes: req.body.notes || '',
          receivedAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date()
        }
      ],
      { session }
    );

    // Paying a supplier clears the payable and takes the money out of cash or bank.
    await createLedgerEntries(
      [
        {
          business: req.business._id,
          sourceType: 'vendor_payment',
          sourceId: payment._id,
          account: 'accounts_payable',
          direction: 'debit',
          amount,
          currency: 'INR',
          entryDate: payment.receivedAt,
          description: `Paid ${vendor.name}${bill ? ` against ${bill.billNumber}` : ''}`,
          createdBy: req.user._id
        },
        {
          business: req.business._id,
          sourceType: 'vendor_payment',
          sourceId: payment._id,
          account: fundingAccountFor(method),
          direction: 'credit',
          amount,
          currency: 'INR',
          entryDate: payment.receivedAt,
          description: `Paid ${vendor.name} by ${method}`,
          createdBy: req.user._id
        }
      ],
      { session }
    );

    if (bill) {
      bill.paidAmount = money(Number(bill.paidAmount) + amount);
      bill.balanceDue = money(Math.max(Number(bill.total) - bill.paidAmount, 0));
      bill.paymentStatus = bill.balanceDue <= 0 ? 'paid' : 'partial';
      bill.updatedBy = req.user._id;
      await bill.save({ session });
    }

    const totals = await refreshVendorPayable(req.business._id, vendor._id, { session, actorId: req.user._id });

    return { payment, bill, totals };
  });

/** Purchase totals for a period — feeds the reports COGS/purchases view. */
export const purchaseTotals = async (businessId, { from, to } = {}) => {
  const match = { business: businessId, status: 'received' };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = from;
    if (to) match.date.$lte = to;
  }

  const [row] = await PurchaseBill.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 }, unpaid: { $sum: '$balanceDue' } } }
  ]);

  return { total: money(row?.total || 0), count: row?.count || 0, outstanding: money(row?.unpaid || 0) };
};
