import { body, query } from 'express-validator';
import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js';
import { emitUserEvent } from '../services/socketService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { paginateQuery, wantsPagination } from '../utils/pagination.js';

export const customerRules = [
  body('name').trim().notEmpty().withMessage('Customer name is required').isLength({ max: 120 }),
  body('phone').trim().notEmpty().withMessage('Phone is required').isLength({ max: 24 }),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
  body('address').optional({ nullable: true }).trim().isLength({ max: 500 })
];

export const customerQueryRules = [
  query('search').optional().trim().isLength({ max: 80 }),
  query('contactInfo').optional({ checkFalsy: true }).isIn(['withEmail', 'withoutEmail', 'withAddress', 'withoutAddress']),
  query('billingStatus').optional().isIn(['all', 'invoiced', 'notInvoiced', 'pending', 'paid']),
  query('sort').optional().isIn(['updated', 'newest', 'oldest', 'name-asc']),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

export const listCustomers = asyncHandler(async (req, res) => {
  const { search = '', contactInfo = '', billingStatus = 'all', sort = 'updated' } = req.query;
  const filter = { user: req.user._id };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } }
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
      user: req.user._id,
      customer: { $ne: null }
    };

    if (billingStatus === 'pending') invoiceFilter.status = 'pending';
    if (billingStatus === 'paid') invoiceFilter.status = 'paid';

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

  const query = Customer.find(filter).sort(sortMap[sort] || sortMap.updated);

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Customer.countDocuments(filter), req.query);
    return res.json({ success: true, customers: items, pagination });
  }

  const customers = await query;
  res.json({ success: true, customers });
});

const emitCustomerChanges = (userId, reason) => {
  emitUserEvent(userId, 'customers:changed', { reason });
};

export const createCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.create({
    ...req.body,
    user: req.user._id
  });

  emitCustomerChanges(req.user._id, 'customer_created');
  res.status(201).json({ success: true, customer });
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, req.body, {
    new: true,
    runValidators: true
  });

  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }

  emitCustomerChanges(req.user._id, 'customer_updated');
  res.json({ success: true, customer });
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findOneAndDelete({ _id: req.params.id, user: req.user._id });

  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }

  emitCustomerChanges(req.user._id, 'customer_deleted');
  res.json({ success: true, message: 'Customer deleted' });
});
