import mongoose from 'mongoose';
import { bootstrapRbac } from '../bootstrap/rbac.js';
import { connectDB } from '../config/db.js';
import Business from '../models/Business.js';
import BusinessMember from '../models/BusinessMember.js';
import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { buildInvoicePayload, setInvoicePdfUrl, stockAdjustmentsForInvoice } from '../services/invoiceService.js';

const seed = async () => {
  await connectDB();
  await bootstrapRbac();

  // Idempotent seed: clear any prior demo data so re-running does not collide
  // on unique indexes or accumulate duplicates.
  const existing = await User.findOne({ email: 'demo@quickinvoice.app' });
  if (existing) {
    const businesses = await Business.find({ owner: existing._id }).select('_id');
    const businessIds = businesses.map((b) => b._id);
    await Promise.all([
      Invoice.deleteMany({ business: { $in: businessIds } }),
      Product.deleteMany({ business: { $in: businessIds } }),
      Customer.deleteMany({ business: { $in: businessIds } }),
      BusinessMember.deleteMany({ business: { $in: businessIds } }),
      Business.deleteMany({ owner: existing._id }),
      User.deleteOne({ _id: existing._id })
    ]);
  }

  const user = await User.create({
    name: 'Demo Owner',
    email: 'demo@quickinvoice.app',
    password: 'password123'
  });
  const business = await Business.create({
    owner: user._id,
    businessName: 'Quick Mart',
    gstNumber: '29ABCDE1234F1Z5',
    phone: '+919876543210',
    email: 'demo@quickinvoice.app',
    address: 'MG Road, Bengaluru',
    invoicePrefix: 'QM'
  });
  await BusinessMember.create({ business: business._id, user: user._id, roleKey: 'owner', joinedAt: new Date() });
  user.defaultBusiness = business._id;
  await user.save();

  const products = await Product.insertMany([
    { business: business._id, createdBy: user._id, updatedBy: user._id, name: 'Premium Coffee Beans', price: 450, stockQuantity: 24, sku: 'COF-001', category: 'Grocery' },
    { business: business._id, createdBy: user._id, updatedBy: user._id, name: 'Notebook A5', price: 80, stockQuantity: 6, sku: 'NOTE-A5', category: 'Stationery' },
    { business: business._id, createdBy: user._id, updatedBy: user._id, name: 'USB-C Cable', price: 299, stockQuantity: 3, sku: 'USB-C-1M', category: 'Electronics' },
    { business: business._id, createdBy: user._id, updatedBy: user._id, name: 'Desk Lamp', price: 1299, stockQuantity: 10, sku: 'LAMP-01', category: 'Home' }
  ]);

  const customers = await Customer.insertMany([
    { business: business._id, createdBy: user._id, updatedBy: user._id, name: 'Anita Sharma', phone: '+919900001111', email: 'anita@example.com', address: 'Indiranagar, Bengaluru' },
    { business: business._id, createdBy: user._id, updatedBy: user._id, name: 'Rahul Mehta', phone: '+919900002222', email: 'rahul@example.com', address: 'Koramangala, Bengaluru' }
  ]);

  const invoicePayloads = [
    {
      customerId: customers[0]._id,
      items: [
        { productId: products[0]._id, quantity: 2 },
        { productId: products[1]._id, quantity: 3 }
      ],
      taxRate: 5,
      discountType: 'flat',
      discountValue: 50,
      status: 'paid'
    },
    {
      customerId: customers[1]._id,
      items: [
        { productId: products[2]._id, quantity: 1 },
        { name: 'Installation Support', quantity: 1, price: 500 }
      ],
      taxRate: 18,
      discountType: 'percentage',
      discountValue: 5,
      status: 'pending'
    }
  ];

  for (const payload of invoicePayloads) {
    const invoice = await Invoice.create(await buildInvoicePayload(user, business, payload));
    await setInvoicePdfUrl(invoice);
    await stockAdjustmentsForInvoice(invoice, -1);
  }

  console.log('Seed complete');
  console.log('Login: demo@quickinvoice.app / password123');
  await mongoose.disconnect();
};

seed().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
