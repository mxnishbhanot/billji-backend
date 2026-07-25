// The single table driving the data export. Adding a collection to the export =
// adding one entry here; the builder (service.js) is generic over this list.
//
// SECURITY — `select` is an explicit deny-list per entry and it is the export's trust
// boundary. Anything secret or capability-bearing (tokens, hashes, cache keys) must be
// subtracted here, so a field added to a schema later is *absent* from the export until
// someone deliberately widens this list. Collections that are wholly secret or ephemeral
// are simply not listed (see EXCLUDED_COLLECTIONS at the bottom for why).

import AuditLog from '../../models/AuditLog.js';
import Business from '../../models/Business.js';
import BusinessInvitation from '../../models/BusinessInvitation.js';
import BusinessMember from '../../models/BusinessMember.js';
import Customer from '../../models/Customer.js';
import CustomerBalance from '../../models/CustomerBalance.js';
import LedgerEntry from '../../models/LedgerEntry.js';
import Notification from '../../models/Notification.js';
import NumberSequence from '../../models/NumberSequence.js';
import OnboardingProgress from '../../models/OnboardingProgress.js';
import Order from '../../models/Order.js';
import Payment from '../../models/Payment.js';
import PaymentAllocation from '../../models/PaymentAllocation.js';
import Product from '../../models/Product.js';
import Role from '../../models/Role.js';
import SalesDocument from '../../models/SalesDocument.js';
import StockMovement from '../../models/StockMovement.js';
import UserNotificationPreference from '../../models/UserNotificationPreference.js';

// Bump when the CSV column sets or file layout change, so a consumer parsing an old
// archive can tell. Recorded in manifest.json.
export const EXPORT_SCHEMA_VERSION = 1;

const ADDRESS_COLUMNS = (prefix, label) => [
  { header: `${label}Line1`, path: `${prefix}.line1` },
  { header: `${label}Line2`, path: `${prefix}.line2` },
  { header: `${label}City`, path: `${prefix}.city` },
  { header: `${label}State`, path: `${prefix}.state` },
  { header: `${label}PinCode`, path: `${prefix}.pinCode` },
  { header: `${label}Country`, path: `${prefix}.country` }
];

// Line-item sheets: one CSV row per embedded item, keyed back to its parent document.
// `rowsFor` flattens the parent, so items need no second cursor and no separate model.
const lineItemRows = (numberPath) => (doc) =>
  (doc.items || []).map((item) => ({
    parentId: doc._id,
    parentNumber: doc[numberPath],
    parentDate: doc.date,
    ...item
  }));

const LINE_ITEM_COLUMNS = (idHeader, numberHeader) => [
  { header: idHeader, path: 'parentId' },
  { header: numberHeader, path: 'parentNumber' },
  { header: 'date', path: 'parentDate' },
  { header: 'lineId', path: '_id' },
  { header: 'productId', path: 'product' },
  { header: 'name', path: 'name' },
  { header: 'sku', path: 'sku' },
  { header: 'unit', path: 'unit' },
  { header: 'quantity', path: 'quantity' },
  { header: 'price', path: 'price' },
  { header: 'purchasePrice', path: 'purchasePrice' },
  { header: 'taxRate', path: 'taxRate' },
  { header: 'taxAmount', path: 'taxAmount' },
  { header: 'total', path: 'total' },
  { header: 'isCustom', path: 'isCustom' }
];

const CUSTOMER_SNAPSHOT_COLUMNS = [
  { header: 'customerName', path: 'customerSnapshot.name' },
  { header: 'customerPhone', path: 'customerSnapshot.phone' },
  { header: 'customerEmail', path: 'customerSnapshot.email' },
  { header: 'customerGstNumber', path: 'customerSnapshot.gstNumber' }
];

const MONEY_COLUMNS = [
  { header: 'subtotal', path: 'subtotal' },
  { header: 'taxRate', path: 'tax.rate' },
  { header: 'taxAmount', path: 'tax.amount' },
  { header: 'discountType', path: 'discount.type' },
  { header: 'discountValue', path: 'discount.value' },
  { header: 'discountAmount', path: 'discount.amount' },
  { header: 'total', path: 'total' },
  { header: 'paidAmount', path: 'paidAmount' },
  { header: 'balanceDue', path: 'balanceDue' }
];

/**
 * Entry shape:
 *   name      file basename (csv/<name>.csv, json/<name>.json)
 *   model     mongoose model to stream
 *   scope     'business' → { business: id } (default) | 'self' → { _id: id }
 *   select    projection string, always a deny-list (see SECURITY note above)
 *   sort      cursor sort, so archives are reproducible and diffable
 *   populate  optional [{ path, select }]
 *   csv       CsvColumn[] for the spreadsheet view, or null for JSON-only
 *   rowsFor   doc → rows for the CSV (default: [doc]). Used by line-item sheets.
 *   json      false to skip the JSON dump (line items already live inside their parent)
 *
 * @type {Array<object>}
 */
export const EXPORT_COLLECTIONS = [
  {
    name: 'business',
    model: Business,
    scope: 'self',
    select: '-__v',
    csv: [
      { header: 'businessId', path: '_id' },
      { header: 'businessName', path: 'businessName' },
      { header: 'gstNumber', path: 'gstNumber' },
      { header: 'panNumber', path: 'panNumber' },
      { header: 'phone', path: 'phone' },
      { header: 'countryCode', path: 'countryCode' },
      { header: 'email', path: 'email' },
      { header: 'website', path: 'website' },
      { header: 'address', path: 'address' },
      { header: 'city', path: 'city' },
      { header: 'state', path: 'state' },
      { header: 'pinCode', path: 'pinCode' },
      { header: 'invoicePrefix', path: 'invoicePrefix' },
      { header: 'defaultTaxRate', path: 'taxSettings.defaultRate' },
      { header: 'pricesIncludeTax', path: 'taxSettings.pricesIncludeTax' },
      { header: 'plan', path: 'plan.key' },
      { header: 'status', path: 'status' },
      { header: 'createdAt', path: 'createdAt' }
    ]
  },
  {
    name: 'team',
    model: BusinessMember,
    select: '-__v',
    sort: { joinedAt: 1 },
    // User.password and User.twoFactor.* are select:false at the schema level, so they
    // cannot ride along here even by accident. Still narrowed to two fields.
    populate: [{ path: 'user', select: 'name email' }],
    csv: [
      { header: 'memberId', path: '_id' },
      { header: 'userId', path: 'user._id' },
      { header: 'name', path: 'user.name' },
      { header: 'email', path: 'user.email' },
      { header: 'roleKey', path: 'roleKey' },
      { header: 'customRoleId', path: 'role' },
      { header: 'status', path: 'status' },
      { header: 'joinedAt', path: 'joinedAt' },
      { header: 'archivedAt', path: 'archivedAt' },
      { header: 'removedAt', path: 'removedAt' }
    ]
  },
  {
    name: 'customers',
    model: Customer,
    select: '-__v',
    sort: { createdAt: 1 },
    csv: [
      { header: 'customerId', path: '_id' },
      { header: 'name', path: 'name' },
      { header: 'phone', path: 'phone' },
      { header: 'countryCode', path: 'countryCode' },
      { header: 'email', path: 'email' },
      { header: 'gstNumber', path: 'gstNumber' },
      { header: 'panNumber', path: 'taxIdentifiers.panNumber' },
      { header: 'taxId', path: 'taxIdentifiers.taxId' },
      ...ADDRESS_COLUMNS('billingAddress', 'billing'),
      ...ADDRESS_COLUMNS('shippingAddress', 'shipping'),
      { header: 'creditBalance', path: 'creditBalance' },
      { header: 'outstandingDues', path: 'outstandingDues' },
      { header: 'isActive', path: 'isActive' },
      { header: 'createdAt', path: 'createdAt' },
      { header: 'updatedAt', path: 'updatedAt' }
    ]
  },
  {
    name: 'products',
    model: Product,
    select: '-__v',
    sort: { createdAt: 1 },
    csv: [
      { header: 'productId', path: '_id' },
      { header: 'name', path: 'name' },
      { header: 'sku', path: 'sku' },
      { header: 'category', path: 'category' },
      { header: 'unit', path: 'unit' },
      { header: 'price', path: 'price' },
      { header: 'salePrice', path: 'salePrice' },
      { header: 'purchasePrice', path: 'purchasePrice' },
      { header: 'taxRate', path: 'taxRate' },
      { header: 'stockQuantity', path: 'stockQuantity' },
      { header: 'trackStock', path: 'trackStock' },
      { header: 'lowStockThreshold', path: 'lowStockThreshold' },
      { header: 'isActive', path: 'isActive' },
      { header: 'createdAt', path: 'createdAt' },
      { header: 'updatedAt', path: 'updatedAt' }
    ]
  },
  {
    name: 'invoices',
    model: SalesDocument,
    // shareToken and pdfCacheKey are live capabilities — a leaked archive must not hand
    // out working invoice links. pdfUrl is a rendered artefact, regenerated on demand.
    select: '-__v -shareToken -pdfCacheKey -pdfUrl',
    sort: { date: 1, _id: 1 },
    csv: [
      { header: 'invoiceId', path: '_id' },
      { header: 'documentType', path: 'documentType' },
      { header: 'documentNumber', path: 'documentNumber' },
      { header: 'invoiceNumber', path: 'invoiceNumber' },
      { header: 'date', path: 'date' },
      { header: 'dueDate', path: 'dueDate' },
      { header: 'customerId', path: 'customer' },
      { header: 'sourceOrderId', path: 'sourceOrder' },
      ...CUSTOMER_SNAPSHOT_COLUMNS,
      ...MONEY_COLUMNS,
      { header: 'documentStatus', path: 'documentStatus' },
      { header: 'paymentStatus', path: 'paymentStatus' },
      { header: 'fulfillmentStatus', path: 'fulfillmentStatus' },
      { header: 'itemCount', value: (doc) => (doc.items || []).length },
      { header: 'notes', path: 'notes' },
      { header: 'cancelledAt', path: 'cancelledAt' },
      { header: 'cancelReason', path: 'cancelReason' },
      { header: 'emailedAt', path: 'emailedAt' },
      { header: 'createdAt', path: 'createdAt' },
      { header: 'updatedAt', path: 'updatedAt' }
    ]
  },
  {
    name: 'invoice_items',
    model: SalesDocument,
    select: '_id documentNumber date items',
    sort: { date: 1, _id: 1 },
    rowsFor: lineItemRows('documentNumber'),
    csv: LINE_ITEM_COLUMNS('invoiceId', 'documentNumber'),
    json: false
  },
  {
    name: 'orders',
    model: Order,
    select: '-__v',
    sort: { date: 1, _id: 1 },
    csv: [
      { header: 'orderId', path: '_id' },
      { header: 'orderNumber', path: 'orderNumber' },
      { header: 'date', path: 'date' },
      { header: 'customerId', path: 'customer' },
      ...CUSTOMER_SNAPSHOT_COLUMNS,
      ...MONEY_COLUMNS,
      { header: 'orderStatus', path: 'orderStatus' },
      { header: 'fulfillmentStatus', path: 'fulfillmentStatus' },
      { header: 'paymentStatus', path: 'paymentStatus' },
      { header: 'itemCount', value: (doc) => (doc.items || []).length },
      { header: 'notes', path: 'notes' },
      { header: 'createdAt', path: 'createdAt' },
      { header: 'updatedAt', path: 'updatedAt' }
    ]
  },
  {
    name: 'order_items',
    model: Order,
    select: '_id orderNumber date items',
    sort: { date: 1, _id: 1 },
    rowsFor: lineItemRows('orderNumber'),
    csv: LINE_ITEM_COLUMNS('orderId', 'orderNumber'),
    json: false
  },
  {
    name: 'payments',
    model: Payment,
    // provider.providerSignature is a payment-gateway HMAC; nothing downstream needs it.
    select: '-__v -provider.providerSignature',
    sort: { receivedAt: 1, _id: 1 },
    csv: [
      { header: 'paymentId', path: '_id' },
      { header: 'receivedAt', path: 'receivedAt' },
      { header: 'type', path: 'type' },
      { header: 'method', path: 'method' },
      { header: 'status', path: 'status' },
      { header: 'amount', path: 'amount' },
      { header: 'allocatedAmount', path: 'allocatedAmount' },
      { header: 'unappliedAmount', path: 'unappliedAmount' },
      { header: 'currency', path: 'currency' },
      { header: 'customerId', path: 'customer' },
      { header: 'invoiceId', path: 'invoice' },
      { header: 'reference', path: 'reference' },
      { header: 'refundStatus', path: 'refundStatus' },
      { header: 'refundedAt', path: 'refundedAt' },
      { header: 'provider', path: 'provider.provider' },
      { header: 'providerPaymentId', path: 'provider.providerPaymentId' },
      { header: 'notes', path: 'notes' },
      { header: 'createdAt', path: 'createdAt' }
    ]
  },
  {
    name: 'payment_allocations',
    model: PaymentAllocation,
    select: '-__v',
    sort: { allocatedAt: 1, _id: 1 },
    csv: [
      { header: 'allocationId', path: '_id' },
      { header: 'paymentId', path: 'payment' },
      { header: 'invoiceId', path: 'invoice' },
      { header: 'customerId', path: 'customer' },
      { header: 'amount', path: 'amount' },
      { header: 'allocatedAt', path: 'allocatedAt' }
    ]
  },
  {
    name: 'ledger_entries',
    model: LedgerEntry,
    select: '-__v',
    sort: { entryDate: 1, _id: 1 },
    csv: [
      { header: 'entryId', path: '_id' },
      { header: 'entryDate', path: 'entryDate' },
      { header: 'sourceType', path: 'sourceType' },
      { header: 'sourceId', path: 'sourceId' },
      { header: 'account', path: 'account' },
      { header: 'direction', path: 'direction' },
      { header: 'amount', path: 'amount' },
      { header: 'currency', path: 'currency' },
      { header: 'customerId', path: 'customer' },
      { header: 'invoiceId', path: 'invoice' },
      { header: 'paymentId', path: 'payment' },
      { header: 'description', path: 'description' },
      { header: 'createdAt', path: 'createdAt' }
    ]
  },
  {
    name: 'stock_movements',
    model: StockMovement,
    select: '-__v',
    sort: { createdAt: 1, _id: 1 },
    csv: [
      { header: 'movementId', path: '_id' },
      { header: 'createdAt', path: 'createdAt' },
      { header: 'productId', path: 'product' },
      { header: 'type', path: 'type' },
      { header: 'quantityChange', path: 'quantityChange' },
      { header: 'stockBefore', path: 'stockBefore' },
      { header: 'stockAfter', path: 'stockAfter' },
      { header: 'documentType', path: 'documentType' },
      { header: 'documentNumber', path: 'documentNumber' },
      { header: 'invoiceId', path: 'invoice' },
      { header: 'note', path: 'note' }
    ]
  },
  {
    name: 'customer_balances',
    model: CustomerBalance,
    select: '-__v',
    sort: { customer: 1 },
    csv: [
      { header: 'customerId', path: 'customer' },
      { header: 'outstandingDues', path: 'outstandingDues' },
      { header: 'creditBalance', path: 'creditBalance' },
      { header: 'currency', path: 'currency' },
      { header: 'lastCalculatedAt', path: 'lastCalculatedAt' }
    ]
  },

  // JSON-only: nobody opens these in a spreadsheet, and their shapes (Mixed maps,
  // nested metadata) flatten badly. Kept for completeness and re-import fidelity.
  { name: 'number_sequences', model: NumberSequence, select: '-__v', sort: { createdAt: 1 }, csv: null },
  { name: 'roles', model: Role, select: '-__v', sort: { createdAt: 1 }, csv: null },
  { name: 'notifications', model: Notification, select: '-__v', sort: { sortDate: 1 }, csv: null },
  { name: 'audit_logs', model: AuditLog, select: '-__v', sort: { createdAt: 1 }, csv: null },
  { name: 'onboarding', model: OnboardingProgress, select: '-__v', sort: { createdAt: 1 }, csv: null },
  {
    name: 'notification_preferences',
    model: UserNotificationPreference,
    select: '-__v',
    sort: { createdAt: 1 },
    csv: null
  },
  {
    name: 'team_invitations',
    model: BusinessInvitation,
    // tokenHash would let a leaked archive be replayed against the accept-invite route.
    select: '-__v -tokenHash',
    sort: { createdAt: 1 },
    csv: null
  }
];

// Deliberately NOT exported — documented so the next person doesn't "helpfully" add them.
//   Session, PasswordResetToken, TrustedDevice, TwoFactorChallenge — credentials.
//   IdempotencyKey, OutboxEvent — internal plumbing, contains cached response bodies.
//   Draft — per-user unsaved scratch, TTL'd after 30d.
//   NotificationRead — per-user UI read/dismiss state, meaningless outside the app.
//   Permission — global catalog, not the business's data (served by GET /permissions).
//   User — only the business's own members, via the `team` entry's narrowed populate.
export const EXCLUDED_COLLECTIONS = [
  'Session',
  'PasswordResetToken',
  'TrustedDevice',
  'TwoFactorChallenge',
  'IdempotencyKey',
  'OutboxEvent',
  'Draft',
  'NotificationRead',
  'Permission'
];
