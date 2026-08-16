import { body, query } from 'express-validator';
import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../services/eventBus.js';
import { emitBusinessEvent } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { EMAIL_NORMALIZE } from '../utils/email.js';
import { paginateQuery, UNPAGINATED_LIST_CAP, wantsPagination } from '../utils/pagination.js';
import { buildSearchRegex } from '../utils/searchRegex.js';

export const customerRules = [
  body('name').trim().notEmpty().withMessage('Customer name is required').isLength({ max: 120 }),
  body('phone').trim().notEmpty().withMessage('Phone is required').isLength({ max: 24 }),
  body('countryCode').optional({ nullable: true }).trim().isLength({ max: 8 }),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(EMAIL_NORMALIZE),
  body('address').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('billingAddress.line1').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('billingAddress.line2').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('billingAddress.city').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('billingAddress.state').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('billingAddress.pinCode').optional({ nullable: true }).trim().isLength({ max: 16 }),
  body('billingAddress.country').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('shippingAddress.line1').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('shippingAddress.line2').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('shippingAddress.city').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('shippingAddress.state').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('shippingAddress.pinCode').optional({ nullable: true }).trim().isLength({ max: 16 }),
  body('shippingAddress.country').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('gstNumber').optional({ nullable: true }).trim().isLength({ max: 32 }),
  body('taxIdentifiers.gstNumber').optional({ nullable: true }).trim().isLength({ max: 32 }),
  body('taxIdentifiers.panNumber').optional({ nullable: true, checkFalsy: true }).trim().matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/i).withMessage('Enter a valid PAN'),
  body('taxIdentifiers.taxId').optional({ nullable: true }).trim().isLength({ max: 64 }),
  body('contactPersons').optional({ nullable: true }).isArray({ max: 10 }),
  body('contactPersons.*.name').optional({ nullable: true }).trim().isLength({ max: 120 }),
  body('contactPersons.*.role').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('contactPersons.*.phone').optional({ nullable: true }).trim().isLength({ max: 24 }),
  body('contactPersons.*.email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(EMAIL_NORMALIZE),
  // `availableCredit` and `outstandingDues` are deliberately absent: they are derived by
  // the server from invoices, allocations and credit notes. A balance a client can set to
  // an arbitrary number is not a balance.
  body('isActive').optional().isBoolean().toBoolean()
];

export const customerQueryRules = [
  query('search').optional().trim().isLength({ max: 80 }),
  query('contactInfo').optional({ checkFalsy: true }).isIn(['withEmail', 'withoutEmail', 'withAddress', 'withoutAddress']),
  query('billingStatus').optional().isIn(['all', 'invoiced', 'notInvoiced', 'pending', 'paid']),
  query('sort').optional().isIn(['updated', 'newest', 'oldest', 'name-asc']),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Last 10 digits — matches mobile normalizePhone so "+91 98765 43210" and "9876543210" collide. */
const normalizePhoneDigits = (phone = '') => {
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const assertPhoneAvailable = async (businessId, phone, excludeId = null) => {
  const normalized = normalizePhoneDigits(phone);
  if (!normalized) return;

  const filter = { business: businessId, deletedAt: null };
  if (excludeId) filter._id = { $ne: excludeId };

  const exact = await Customer.findOne({ ...filter, phone: String(phone).trim() }).select('_id name phone');
  if (exact) {
    throw new ApiError(409, 'A customer with this phone already exists', {
      code: 'CUSTOMER_PHONE_EXISTS',
      customerId: exact._id
    });
  }

  // Catch alternate formatting of the same number (spaces, +91, leading 0).
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sibling = await Customer.findOne({
    ...filter,
    phone: { $regex: `${escaped}$` }
  }).select('_id name phone');

  if (sibling && normalizePhoneDigits(sibling.phone) === normalized) {
    throw new ApiError(409, 'A customer with this phone already exists', {
      code: 'CUSTOMER_PHONE_EXISTS',
      customerId: sibling._id
    });
  }
};

const compactAddress = (address = {}) => ({
  line1: address.line1 || '',
  line2: address.line2 || '',
  city: address.city || '',
  state: address.state || '',
  pinCode: address.pinCode || '',
  country: address.country || 'India'
});

const compactContacts = (contacts = []) =>
  contacts
    .filter((contact) => contact?.name || contact?.phone || contact?.email)
    .map((contact) => ({
      name: contact.name || '',
      role: contact.role || '',
      phone: contact.phone || '',
      email: contact.email || ''
    }));

const customerPayload = (body) => {
  const payload = {
    name: body.name,
    phone: body.phone,
    countryCode: body.countryCode || '+91',
    email: body.email || '',
    address: body.address || ''
  };

  if (hasOwn(body, 'billingAddress')) payload.billingAddress = compactAddress(body.billingAddress);
  if (hasOwn(body, 'shippingAddress')) payload.shippingAddress = compactAddress(body.shippingAddress);
  if (hasOwn(body, 'gstNumber')) payload.gstNumber = body.gstNumber || '';
  if (hasOwn(body, 'taxIdentifiers')) {
    payload.taxIdentifiers = {
      gstNumber: body.taxIdentifiers?.gstNumber || body.gstNumber || '',
      panNumber: body.taxIdentifiers?.panNumber || '',
      taxId: body.taxIdentifiers?.taxId || ''
    };
  }
  if (hasOwn(body, 'contactPersons')) payload.contactPersons = compactContacts(body.contactPersons);
  if (hasOwn(body, 'isActive')) payload.isActive = Boolean(body.isActive);

  return payload;
};

export const listCustomers = asyncHandler(async (req, res) => {
  const { search = '', contactInfo = '', billingStatus = 'all', sort = 'updated' } = req.query;
  const filter = { business: req.business._id };

  const searchRegex = buildSearchRegex(search);
  if (searchRegex) {
    filter.$or = [
      { name: searchRegex },
      { phone: searchRegex },
      { email: searchRegex }
    ];
  }

  if (contactInfo === 'withEmail') {
    filter.email = { $nin: ['', null] };
  } else if (contactInfo === 'withoutEmail') {
    filter.email = { $in: ['', null] };
  } else if (contactInfo === 'withAddress') {
    filter.address = { $nin: ['', null] };
  } else if (contactInfo === 'withoutAddress') {
    filter.address = { $in: ['', null] };
  }

  if (billingStatus && billingStatus !== 'all') {
    const invoiceFilter = {
      business: req.business._id,
      documentType: 'invoice',
      customer: { $ne: null }
    };

    if (billingStatus === 'pending') invoiceFilter.paymentStatus = { $in: ['unpaid', 'partial'] };
    if (billingStatus === 'paid') invoiceFilter.paymentStatus = 'paid';

    const invoicedCustomerIds = await Invoice.distinct('customer', invoiceFilter);

    if (billingStatus === 'notInvoiced') {
      filter._id = { $nin: invoicedCustomerIds };
    } else {
      filter._id = { $in: invoicedCustomerIds };
    }
  }

  const sortMap = {
    updated: { updatedAt: -1 },
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    'name-asc': { name: 1 }
  };

  const query = Customer.find(filter).sort(sortMap[sort] || sortMap.updated).lean();

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Customer.countDocuments(filter), req.query);
    return res.json({ success: true, customers: items, pagination });
  }

  const customers = await query.limit(UNPAGINATED_LIST_CAP);
  res.json({ success: true, customers });
});

const emitCustomerChanges = (businessId, reason) => {
  emitBusinessEvent(businessId, 'customers:changed', { reason });
};

export const createCustomer = asyncHandler(async (req, res) => {
  await assertPhoneAvailable(req.business._id, req.body.phone);

  const customer = await Customer.create({
    ...customerPayload(req.body),
    business: req.business._id,
    createdBy: req.user._id,
    updatedBy: req.user._id
  });

  await publishDomainEvent({
    business: req.business._id,
    actor: req.user._id,
    eventType: DOMAIN_EVENTS.customerCreated,
    aggregateType: 'customer',
    aggregateId: customer._id,
    payload: {
      customerName: customer.name,
      phone: customer.phone,
      actorName: req.user.name
    },
    dedupeKey: `${DOMAIN_EVENTS.customerCreated}:${customer._id}`
  });
  void logAudit(req, { action: 'customer.created', resourceType: 'customer', resourceId: customer._id, metadata: { name: customer.name } });
  res.status(201).json({ success: true, customer });
});

export const updateCustomer = asyncHandler(async (req, res) => {
  if (hasOwn(req.body, 'phone')) {
    await assertPhoneAvailable(req.business._id, req.body.phone, req.params.id);
  }

  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, business: req.business._id }, { ...customerPayload(req.body), updatedBy: req.user._id }, {
    new: true,
    runValidators: true
  });

  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }

  emitCustomerChanges(req.business._id, 'customer_updated');
  void logAudit(req, { action: 'customer.updated', resourceType: 'customer', resourceId: customer._id, metadata: { name: customer.name } });
  res.json({ success: true, customer });
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.softDeleteOne(
    { _id: req.params.id, business: req.business._id },
    { userId: req.user._id }
  );

  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }

  emitCustomerChanges(req.business._id, 'customer_deleted');
  void logAudit(req, { action: 'customer.deleted', resourceType: 'customer', resourceId: customer._id, metadata: { name: customer.name } });
  res.json({ success: true, message: 'Customer deleted' });
});
