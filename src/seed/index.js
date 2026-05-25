import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { buildInvoicePayload, setInvoicePdfUrl, stockAdjustmentsForInvoice } from '../services/invoiceService.js';

const seed = async () => {
  await connectDB();

  await Promise.all([User.deleteMany({ email: 'demo@quickinvoice.app' })]);

  const user = await User.create({
    name: 'Demo Owner',
    email: 'demo@quickinvoice.app',
    password: 'password123',
    businessProfile: {
      businessName: 'Quick Mart',
      gstNumber: '29ABCDE1234F1Z5',
      phone: '9876543210',
      countryCode: '+91',
      email: 'demo@quickinvoice.app',
      address: 'MG Road, Bengaluru',
      invoicePrefix: 'QM'
    }
  });

  const products = await Product.insertMany([
    { user: user._id, name: 'Premium Coffee Beans', price: 450, stockQuantity: 24, sku: 'COF-001', category: 'Grocery' },
    { user: user._id, name: 'Notebook A5', price: 80, stockQuantity: 6, sku: 'NOTE-A5', category: 'Stationery' },
    { user: user._id, name: 'USB-C Cable', price: 299, stockQuantity: 3, sku: 'USB-C-1M', category: 'Electronics' },
    { user: user._id, name: 'Desk Lamp', price: 1299, stockQuantity: 10, sku: 'LAMP-01', category: 'Home' }
  ]);

  const customers = await Customer.insertMany([
    { user: user._id, name: 'Anita Sharma', phone: '9900001111', countryCode: '+91', email: 'anita@example.com', address: 'Indiranagar, Bengaluru' },
    { user: user._id, name: 'Rahul Mehta', phone: '9900002222', countryCode: '+91', email: 'rahul@example.com', address: 'Koramangala, Bengaluru' }
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
    const invoice = await Invoice.create(await buildInvoicePayload(user, payload));
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
