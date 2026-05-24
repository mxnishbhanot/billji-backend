import { body, query } from 'express-validator';
import Product from '../models/Product.js';
import StockMovement from '../models/StockMovement.js';
import { emitUserEvent } from '../services/socketService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { paginateQuery, wantsPagination } from '../utils/pagination.js';

export const productRules = [
  body('name').trim().notEmpty().withMessage('Product name is required').isLength({ max: 120 }),
  body('price').isFloat({ min: 0 }).withMessage('Price must be zero or greater'),
  body('stockQuantity').isInt().withMessage('Stock quantity must be a whole number'),
  body('sku').optional({ nullable: true }).trim().isLength({ max: 64 }),
  body('category').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('lowStockThreshold').optional().isInt({ min: 0 })
];

export const productQueryRules = [
  query('search').optional().trim().isLength({ max: 80 }),
  query('category').optional().trim().isLength({ max: 80 }),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

export const listProducts = asyncHandler(async (req, res) => {
  const { search = '', category = '' } = req.query;
  const filter = { user: req.user._id };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { sku: { $regex: search, $options: 'i' } },
      { category: { $regex: search, $options: 'i' } }
    ];
  }

  if (category) {
    filter.category = category;
  }

  const query = Product.find(filter).sort({ updatedAt: -1 });

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Product.countDocuments(filter), req.query);
    return res.json({ success: true, products: items, pagination });
  }

  const products = await query;
  res.json({ success: true, products });
});

const emitProductChanges = (userId, reason) => {
  emitUserEvent(userId, 'products:changed', { reason });
  emitUserEvent(userId, 'notifications:changed', { reason });
};

export const createProduct = asyncHandler(async (req, res) => {
  const product = await Product.create({
    ...req.body,
    user: req.user._id
  });

  if (product.stockQuantity !== 0) {
    await StockMovement.create({
      user: req.user._id,
      product: product._id,
      type: 'initial_stock',
      quantityChange: product.stockQuantity,
      stockBefore: 0,
      stockAfter: product.stockQuantity,
      note: 'Product created'
    });
  }

  emitProductChanges(req.user._id, 'product_created');
  res.status(201).json({ success: true, product });
});

export const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, user: req.user._id });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  const stockBefore = product.stockQuantity;
  Object.assign(product, req.body);
  await product.save();

  const stockAfter = product.stockQuantity;
  if (req.body.stockQuantity !== undefined && stockAfter !== stockBefore) {
    await StockMovement.create({
      user: req.user._id,
      product: product._id,
      type: 'manual_adjustment',
      quantityChange: stockAfter - stockBefore,
      stockBefore,
      stockAfter,
      note: 'Product stock edited manually'
    });
  }

  emitProductChanges(req.user._id, 'product_updated');
  res.json({ success: true, product });
});

export const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOneAndDelete({ _id: req.params.id, user: req.user._id });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  emitProductChanges(req.user._id, 'product_deleted');
  res.json({ success: true, message: 'Product deleted' });
});

export const listProductStockMovements = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, user: req.user._id });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  const filter = { user: req.user._id, product: product._id };
  const query = StockMovement.find(filter).sort({ createdAt: -1 });

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, StockMovement.countDocuments(filter), req.query);
    return res.json({ success: true, movements: items, pagination });
  }

  const movements = await query.limit(100);

  res.json({ success: true, movements });
});
