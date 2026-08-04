import { FEATURES } from '../../constants/entitlements.js';
import { PERMISSIONS } from '../../middlewares/authorization.js';
import Customer from '../../models/Customer.js';
import Expense from '../../models/Expense.js';
import Invoice from '../../models/Invoice.js';
import Order from '../../models/Order.js';
import Payment from '../../models/Payment.js';
import Product from '../../models/Product.js';
import Referral from '../../models/Referral.js';
import PurchaseBill from '../../models/PurchaseBill.js';
import Vendor from '../../models/Vendor.js';
import {
  createCustomer,
  customerRules,
  deleteCustomer,
  updateCustomer
} from '../../controllers/customerController.js';
import { createInvoice, deleteInvoice, invoiceRules } from '../../controllers/invoiceController.js';
import {
  createProduct,
  deleteProduct,
  productRules,
  updateProduct
} from '../../controllers/productController.js';
import { createExpense, deleteExpense, expenseRules, updateExpense } from '../expenses/controller.js';
import { createOrder } from '../orders/controller.js';
import { orderRules } from '../orders/schema.js';
import { recordCustomerPayment, recordInvoicePayment } from '../payments/controller.js';
import {
  customerPaymentParamRules,
  invoicePaymentParamRules,
  recordCustomerPaymentRules,
  recordPaymentRules
} from '../payments/schema.js';
import { createPurchase, createVendor, purchaseRules, updateVendor, vendorRules } from '../purchases/controller.js';
import { applyReferral } from '../referrals/controller.js';
import { applyReferralRules } from '../referrals/schema.js';
import { commitPushedDocumentNumber, guardPushedDocumentNumber } from './deviceRegistry.js';

// Fields a device must never receive: a share token is a bearer credential for the public
// invoice link, and the PDF cache key is internal storage addressing.
const INVOICE_PROJECTION = '-shareToken -pdfCacheKey';

// Every collection a device can pull. All of them carry the syncable plugin, which is what
// gives them the (business, updatedAt, _id) cursor index this protocol scans.
export const SYNC_COLLECTIONS = {
  customers: { model: Customer, permission: PERMISSIONS.customersView },
  products: { model: Product, permission: PERMISSIONS.productsView },
  invoices: { model: Invoice, permission: PERMISSIONS.invoicesView, projection: INVOICE_PROJECTION },
  payments: { model: Payment, permission: PERMISSIONS.paymentsView },
  orders: { model: Order, permission: PERMISSIONS.ordersView },
  expenses: { model: Expense, permission: PERMISSIONS.expensesView },
  purchases: { model: PurchaseBill, permission: PERMISSIONS.purchasesView },
  vendors: { model: Vendor, permission: PERMISSIONS.purchasesView }
};

export const SYNC_COLLECTION_NAMES = Object.keys(SYNC_COLLECTIONS);

// Bootstrap is deliberately not "download everything". Phase 1 is the smallest set that
// makes the app usable — the catalogue, the customer book, and the documents with money
// still outstanding. Phase 2 is the recent history, pulled in the background. Anything
// older is fetched on demand and never lands on the device at bootstrap.
export const BOOTSTRAP_PHASE_1 = {
  customers: {},
  products: { isActive: true },
  orders: { orderStatus: { $in: ['draft', 'confirmed'] } },
  invoices: {
    documentType: 'invoice',
    paymentStatus: { $in: ['unpaid', 'partial'] },
    documentStatus: { $nin: ['cancelled', 'void'] }
  }
};

export const bootstrapPhase2 = (since) => ({
  invoices: { date: { $gte: since } },
  payments: { receivedAt: { $gte: since } },
  orders: { date: { $gte: since } },
  expenses: { date: { $gte: since } },
  purchases: { date: { $gte: since } },
  vendors: {}
});

const byTargetId = (op) => ({ id: op.targetId });

// Push is an adapter, not a second implementation: each operation is routed to the exact
// controller, validator chain and permission the online route uses. Anything missing from
// this table is rejected as unsupported rather than guessed at.
//
// Entities absent by design: invoice update (an issued invoice is immutable), order and
// purchase mutation (their state changes are domain actions, which are a later phase).
//
// `feature` is the subscription counterpart of `permission`: route middleware never runs on this
// path, so an entry that needs an entitlement declares it here and the push executor enforces it
// with the same helper the routes use. There is deliberately no `meter` field — every metered
// create is metered inside its controller, which this path *does* run, and metering a document
// twice would be worse than not metering it at all. The push path marks the request as offline
// so those in-controller quotas count and warn instead of refusing (§offline rule).
export const PUSH_OPERATIONS = {
  'product:create': {
    permission: PERMISSIONS.productsManage,
    rules: productRules,
    handler: createProduct,
    model: Product,
    resultKey: 'product'
  },
  'product:update': {
    permission: PERMISSIONS.productsManage,
    rules: productRules,
    handler: updateProduct,
    model: Product,
    resultKey: 'product',
    params: byTargetId,
    requiresTarget: true
  },
  'product:delete': {
    permission: PERMISSIONS.productsManage,
    handler: deleteProduct,
    model: Product,
    params: byTargetId,
    requiresTarget: true
  },
  'customer:create': {
    permission: PERMISSIONS.customersManage,
    rules: customerRules,
    handler: createCustomer,
    model: Customer,
    resultKey: 'customer'
  },
  'customer:update': {
    permission: PERMISSIONS.customersManage,
    rules: customerRules,
    handler: updateCustomer,
    model: Customer,
    resultKey: 'customer',
    params: byTargetId,
    requiresTarget: true
  },
  'customer:delete': {
    permission: PERMISSIONS.customersManage,
    handler: deleteCustomer,
    model: Customer,
    params: byTargetId,
    requiresTarget: true
  },
  'invoice:create': {
    permission: PERMISSIONS.invoicesCreate,
    rules: invoiceRules,
    handler: createInvoice,
    model: Invoice,
    resultKey: 'invoice',
    // An invoice written offline arrives with the number already printed on the customer's
    // copy. `before` proves that number belongs to the sending device's series; `after`
    // records the position as issued, so nothing else can be given the same number.
    before: (req, op) => guardPushedDocumentNumber(req, op, 'invoice'),
    after: (req, _record, claim) => commitPushedDocumentNumber(req, claim)
  },
  'invoice:delete': {
    permission: PERMISSIONS.invoicesDelete,
    handler: deleteInvoice,
    model: Invoice,
    params: byTargetId,
    requiresTarget: true
  },
  'order:create': {
    permission: PERMISSIONS.ordersCreate,
    rules: orderRules,
    handler: createOrder,
    model: Order,
    resultKey: 'order'
  },
  'expense:create': {
    permission: PERMISSIONS.expensesManage,
    feature: FEATURES.expenses,
    rules: expenseRules,
    handler: createExpense,
    model: Expense,
    resultKey: 'expense'
  },
  'expense:update': {
    permission: PERMISSIONS.expensesManage,
    feature: FEATURES.expenses,
    rules: expenseRules,
    handler: updateExpense,
    model: Expense,
    resultKey: 'expense',
    params: byTargetId,
    requiresTarget: true
  },
  'expense:delete': {
    permission: PERMISSIONS.expensesManage,
    feature: FEATURES.expenses,
    handler: deleteExpense,
    model: Expense,
    params: byTargetId,
    requiresTarget: true
  },
  'vendor:create': {
    permission: PERMISSIONS.purchasesManage,
    feature: FEATURES.purchases,
    rules: vendorRules,
    handler: createVendor,
    model: Vendor,
    resultKey: 'vendor'
  },
  'vendor:update': {
    permission: PERMISSIONS.purchasesManage,
    feature: FEATURES.purchases,
    rules: vendorRules,
    handler: updateVendor,
    model: Vendor,
    resultKey: 'vendor',
    params: byTargetId,
    requiresTarget: true
  },
  'purchase:create': {
    permission: PERMISSIONS.purchasesManage,
    feature: FEATURES.purchases,
    rules: purchaseRules,
    handler: createPurchase,
    model: PurchaseBill,
    resultKey: 'purchase'
  },
  // Payments are nested under the document they settle, so the target id travels in the
  // payload. Two entity names rather than one branching entity, because the validator
  // chain and the controller differ.
  'payment:create': {
    permission: PERMISSIONS.paymentsRecord,
    rules: [...invoicePaymentParamRules, ...recordPaymentRules],
    handler: recordInvoicePayment,
    model: Payment,
    resultKey: 'payment',
    params: (op) => ({ invoiceId: op.payload?.invoiceId })
  },
  // A referral code typed while the device was offline, or one whose attach failed during signup.
  // Routed to the same controller, validator chain and permission as POST /referrals/apply — the
  // server decides validity, eligibility and the reward, exactly as it does online. Fully idempotent:
  // the push path echo-matches on clientId, Referral.referredUser is unique, and the reward engine
  // holds its own (rule, dedupeKey) lock, so a replayed op can never mint a second free month.
  'referral:create': {
    permission: PERMISSIONS.billingManage,
    rules: applyReferralRules,
    handler: applyReferral,
    model: Referral,
    resultKey: 'referral'
  },
  'customerPayment:create': {
    permission: PERMISSIONS.paymentsRecord,
    rules: [...customerPaymentParamRules, ...recordCustomerPaymentRules],
    handler: recordCustomerPayment,
    model: Payment,
    resultKey: 'payment',
    params: (op) => ({ customerId: op.payload?.customerId })
  }
};

export const PUSH_ENTITIES = [...new Set(Object.keys(PUSH_OPERATIONS).map((key) => key.split(':')[0]))];
