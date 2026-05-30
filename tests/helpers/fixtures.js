import crypto from 'crypto';
import Business from '../../src/models/Business.js';
import BusinessMember from '../../src/models/BusinessMember.js';
import Customer from '../../src/models/Customer.js';
import Product from '../../src/models/Product.js';
import User from '../../src/models/User.js';
import { signToken } from '../../src/utils/jwt.js';

export const createTestContext = async ({ roleKey = 'owner' } = {}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await User.create({
    name: 'Test User',
    email: `test-${suffix}@billji.local`,
    password: 'password123'
  });
  const business = await Business.create({
    owner: user._id,
    businessName: 'Test Business',
    invoicePrefix: 'TST'
  });
  const membership = await BusinessMember.create({
    business: business._id,
    user: user._id,
    roleKey,
    status: 'active'
  });

  user.defaultBusiness = business._id;
  await user.save();

  return {
    user,
    business,
    membership,
    token: signToken(user._id)
  };
};

export const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

export const createCustomer = (business, overrides = {}) =>
  Customer.create({
    business: business._id,
    name: 'Acme Customer',
    phone: '9876543210',
    countryCode: '+91',
    ...overrides
  });

export const createProduct = (business, overrides = {}) =>
  Product.create({
    business: business._id,
    name: 'Test Product',
    price: 100,
    stockQuantity: 10,
    lowStockThreshold: 2,
    trackStock: true,
    ...overrides
  });

export const invoicePayload = ({ customer, product, quantity = 2, allowOversell = false } = {}) => ({
  customerId: customer?._id?.toString(),
  items: [
    {
      productId: product?._id?.toString(),
      quantity,
      price: product?.price ?? 100
    }
  ],
  taxRate: 18,
  discountType: 'flat',
  discountValue: 0,
  notes: 'Test invoice',
  allowOversell
});
