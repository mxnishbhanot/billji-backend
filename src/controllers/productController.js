import { body, query } from 'express-validator';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import StockMovement from '../models/StockMovement.js';
import { emitUserEvent } from '../services/socketService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, paginateQuery, paginationMeta, wantsPagination } from '../utils/pagination.js';

export const productRules = [
  body('name').trim().notEmpty().withMessage('Product name is required').isLength({ max: 120 }),
  body('price').isFloat({ min: 0 }).withMessage('Price must be zero or greater'),
  body('stockQuantity').isInt().withMessage('Stock quantity must be a whole number'),
  body('sku').optional({ nullable: true }).trim().isLength({ max: 64 }),
  body('category').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('lowStockThreshold').optional().isInt({ min: 0 })
];

const parseDateParam = (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
};
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

export const productQueryRules = [
  query('search').optional().trim().isLength({ max: 80 }),
  query('category').optional().trim().isLength({ max: 80 }),
  query('stockStatus').optional().isIn(['all', 'available', 'low', 'out']),
  query('minPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  query('maxPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  query('sort').optional().isIn(['updated', 'top-sales', 'name-asc', 'price-high', 'price-low', 'stock-low']),
  query('from').optional({ checkFalsy: true }).isISO8601(),
  query('to').optional({ checkFalsy: true }).isISO8601(),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

export const listProducts = asyncHandler(async (req, res) => {
  const { search = '', category = '', stockStatus = 'all', minPrice = '', maxPrice = '', sort = 'updated', from = '', to = '' } = req.query;
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

  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  if (stockStatus === 'available') {
    filter.stockQuantity = { $gt: 0 };
  } else if (stockStatus === 'out') {
    filter.stockQuantity = { $lte: 0 };
  } else if (stockStatus === 'low') {
    filter.$expr = { $lte: ['$stockQuantity', '$lowStockThreshold'] };
  }

  const sortMap = {
    updated: { updatedAt: -1 },
    'name-asc': { name: 1 },
    'price-high': { price: -1 },
    'price-low': { price: 1 },
    'stock-low': { stockQuantity: 1 }
  };

  if (sort === 'top-sales') {
    const invoiceMatch = { user: req.user._id, status: { $ne: 'cancelled' } };
    if (from || to) {
      invoiceMatch.date = {};
      if (from) invoiceMatch.date.$gte = startOfDay(parseDateParam(from));
      if (to) invoiceMatch.date.$lte = endOfDay(parseDateParam(to));
    }

    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: Invoice.collection.name,
          let: { productId: '$_id' },
          pipeline: [
            { $match: invoiceMatch },
            { $unwind: '$items' },
            { $match: { $expr: { $eq: ['$items.product', '$$productId'] } } },
            {
              $group: {
                _id: null,
                totalSales: { $sum: '$items.total' },
                quantitySold: { $sum: '$items.quantity' }
              }
            }
          ],
          as: 'salesStats'
        }
      },
      {
        $addFields: {
          totalSales: { $ifNull: [{ $first: '$salesStats.totalSales' }, 0] },
          quantitySold: { $ifNull: [{ $first: '$salesStats.quantitySold' }, 0] },
          isLowStock: { $lte: ['$stockQuantity', '$lowStockThreshold'] }
        }
      },
      { $match: { totalSales: { $gt: 0 } } },
      { $project: { salesStats: 0 } },
      { $sort: { totalSales: -1, quantitySold: -1, updatedAt: -1 } }
    ];

    if (wantsPagination(req.query)) {
      const { page, limit, skip } = getPagination(req.query);
      const [items, totalResult] = await Promise.all([
        Product.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
        Product.aggregate([...pipeline, { $count: 'total' }])
      ]);
      return res.json({ success: true, products: items, pagination: paginationMeta({ page, limit, total: totalResult[0]?.total || 0 }) });
    }

    const products = await Product.aggregate(pipeline);
    return res.json({ success: true, products });
  }

  const query = Product.find(filter).sort(sortMap[sort] || sortMap.updated);

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Product.countDocuments(filter), req.query);
    return res.json({ success: true, products: items, pagination });
  }

  const products = await query;
  res.json({ success: true, products });
});

export const listProductCategories = asyncHandler(async (req, res) => {
  const categories = await Product.distinct('category', {
    user: req.user._id,
    category: { $nin: ['', null] }
  });

  res.json({
    success: true,
    categories: categories
      .filter((category) => typeof category === 'string' && category.trim())
      .map((category) => category.trim())
      .sort((a, b) => a.localeCompare(b))
  });
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
  const query = StockMovement.find(filter).sort({ createdAt: -1 }).lean();
  const [summary = { quantitySold: 0, revenue: 0, orderCount: 0 }] = await Invoice.aggregate([
    { $match: { user: req.user._id, status: { $ne: 'cancelled' }, 'items.product': product._id } },
    { $unwind: '$items' },
    { $match: { 'items.product': product._id } },
    {
      $group: {
        _id: null,
        quantitySold: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.total' },
        orderIds: { $addToSet: '$_id' }
      }
    },
    {
      $project: {
        _id: 0,
        quantitySold: 1,
        revenue: 1,
        orderCount: { $size: '$orderIds' }
      }
    }
  ]);

  const enrichMovements = async (movements) => {
    const invoiceIds = [...new Set(movements.map((movement) => movement.invoice?.toString()).filter(Boolean))];
    const invoices = invoiceIds.length
      ? await Invoice.find({ _id: { $in: invoiceIds }, user: req.user._id })
        .select('invoiceNumber customerSnapshot items status date')
        .lean()
      : [];
    const invoiceMap = new Map(invoices.map((invoice) => [invoice._id.toString(), invoice]));

    return movements.map((movement) => {
      const invoice = movement.invoice ? invoiceMap.get(movement.invoice.toString()) : null;
      const productItems = invoice?.items?.filter((item) => item.product?.toString() === product._id.toString()) ?? [];
      const invoiceQuantity = productItems.reduce((total, item) => total + Number(item.quantity || 0), 0);
      const invoiceTotalForProduct = productItems.reduce((total, item) => total + Number(item.total || 0), 0);

      return {
        ...movement,
        customerName: invoice?.customerSnapshot?.name || '',
        invoiceQuantity,
        invoiceTotalForProduct,
        invoiceStatus: invoice?.status || '',
        invoiceDate: invoice?.date || null
      };
    });
  };

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, StockMovement.countDocuments(filter), req.query);
    const movements = await enrichMovements(items);
    return res.json({
      success: true,
      product: {
        _id: product._id,
        name: product.name,
        price: product.price,
        stockQuantity: product.stockQuantity,
        sku: product.sku,
        category: product.category
      },
      summary,
      movements,
      pagination
    });
  }

  const movements = await enrichMovements(await query.limit(100));

  res.json({
    success: true,
    product: {
      _id: product._id,
      name: product.name,
      price: product.price,
      stockQuantity: product.stockQuantity,
      sku: product.sku,
      category: product.category
    },
    summary,
    movements
  });
});
