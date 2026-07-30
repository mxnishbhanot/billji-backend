import { body, query } from 'express-validator';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import StockMovement from '../models/StockMovement.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../services/eventBus.js';
import { emitBusinessEvent } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, paginateQuery, paginationMeta, UNPAGINATED_LIST_CAP, wantsPagination } from '../utils/pagination.js';
import { buildSearchRegex } from '../utils/searchRegex.js';
import { withTransaction } from '../utils/transaction.js';

export const productRules = [
  body('name').trim().notEmpty().withMessage('Product name is required').isLength({ max: 120 }),
  body('price').isFloat({ min: 0 }).withMessage('Price must be zero or greater'),
  body('salePrice').optional().isFloat({ min: 0 }),
  body('purchasePrice').optional().isFloat({ min: 0 }),
  body('stockQuantity').isInt({ min: 0 }).withMessage('Stock quantity must be zero or greater'),
  body('sku').optional({ nullable: true }).trim().isLength({ max: 64 }),
  body('category').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('unit').optional({ nullable: true }).trim().isLength({ max: 24 }),
  body('hsn').optional({ nullable: true }).trim().isLength({ max: 8 }).withMessage('HSN/SAC must be 8 characters or fewer'),
  body('barcode').optional({ nullable: true }).trim().isLength({ max: 64 }).withMessage('Barcode must be 64 characters or fewer'),
  body('taxRate').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
  body('trackStock').optional().isBoolean().toBoolean(),
  body('lowStockThreshold').optional().isInt({ min: 0 }),
  body('isActive').optional().isBoolean().toBoolean()
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
  query('status').optional().isIn(['all', 'active', 'inactive']),
  query('minPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  query('maxPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  query('sort').optional().isIn(['updated', 'top-sales', 'name-asc', 'price-high', 'price-low', 'stock-low']),
  query('from').optional({ checkFalsy: true }).isISO8601(),
  query('to').optional({ checkFalsy: true }).isISO8601(),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const productPayload = (body, { defaults = false } = {}) => {
  const payload = {
    name: body.name,
    price: body.price ?? body.salePrice,
    salePrice: body.salePrice ?? body.price,
    stockQuantity: body.stockQuantity,
    sku: body.sku || '',
    category: body.category || '',
    lowStockThreshold: body.lowStockThreshold
  };

  if (defaults || hasOwn(body, 'purchasePrice')) payload.purchasePrice = body.purchasePrice ?? 0;
  if (defaults || hasOwn(body, 'unit')) payload.unit = body.unit || 'pcs';
  if (defaults || hasOwn(body, 'hsn')) payload.hsn = body.hsn || '';
  if (defaults || hasOwn(body, 'barcode')) payload.barcode = body.barcode || '';
  if (defaults || hasOwn(body, 'taxRate')) payload.taxRate = body.taxRate ?? 0;
  if (defaults || hasOwn(body, 'trackStock')) payload.trackStock = body.trackStock ?? true;
  if (defaults || hasOwn(body, 'isActive')) payload.isActive = body.isActive ?? true;

  return payload;
};

export const listProducts = asyncHandler(async (req, res) => {
  const { search = '', category = '', stockStatus = 'all', status = 'all', minPrice = '', maxPrice = '', sort = 'updated', from = '', to = '' } = req.query;
  const filter = { business: req.business._id };

  // A scanned code is an exact identifier, not a search term: when the query matches a
  // barcode exactly, return that product alone. Otherwise a scan of "5901234123457" could
  // come back behind a product whose name happens to contain those digits.
  const scanned = String(search || '').trim();
  const barcodeMatch = scanned ? await Product.findOne({ business: req.business._id, barcode: scanned }).select('_id').lean() : null;

  if (barcodeMatch) {
    filter._id = barcodeMatch._id;
  } else {
    const searchRegex = buildSearchRegex(search);
    if (searchRegex) {
      filter.$or = [
        { name: searchRegex },
        { sku: searchRegex },
        { barcode: searchRegex },
        { category: searchRegex }
      ];
    }
  }

  if (category) {
    filter.category = category;
  }

  if (status === 'active') {
    filter.isActive = true;
  } else if (status === 'inactive') {
    filter.isActive = false;
  }

  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  if (stockStatus === 'available') {
    filter.trackStock = { $ne: false };
    filter.stockQuantity = { $gt: 0 };
  } else if (stockStatus === 'out') {
    filter.trackStock = { $ne: false };
    filter.stockQuantity = { $lte: 0 };
  } else if (stockStatus === 'low') {
    filter.trackStock = { $ne: false };
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
    const invoiceMatch = { business: req.business._id, documentType: 'invoice', documentStatus: { $nin: ['cancelled', 'void'] } };
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

  const query = Product.find(filter).sort(sortMap[sort] || sortMap.updated).lean();

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Product.countDocuments(filter), req.query);
    return res.json({ success: true, products: items, pagination });
  }

  const products = await query.limit(UNPAGINATED_LIST_CAP);
  res.json({ success: true, products });
});

export const listProductCategories = asyncHandler(async (req, res) => {
  const categories = await Product.distinct('category', {
    business: req.business._id,
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

const emitProductChanges = (businessId, reason) => {
  emitBusinessEvent(businessId, 'products:changed', { reason });
  emitBusinessEvent(businessId, 'notifications:changed', { reason });
};

export const createProduct = asyncHandler(async (req, res) => {
  const product = await withTransaction(async (session) => {
    const [createdProduct] = await Product.create([{
      ...productPayload(req.body, { defaults: true }),
      business: req.business._id,
      createdBy: req.user._id,
      updatedBy: req.user._id
    }], { session });

    if (createdProduct.trackStock !== false && createdProduct.stockQuantity !== 0) {
      const [movement] = await StockMovement.create([{
        business: req.business._id,
        createdBy: req.user._id,
        product: createdProduct._id,
        type: 'opening_stock',
        quantityChange: createdProduct.stockQuantity,
        stockBefore: 0,
        stockAfter: createdProduct.stockQuantity,
        note: 'Product created'
      }], { session });
      await publishDomainEvent(
        {
          business: req.business._id,
          actor: req.user._id,
          eventType: DOMAIN_EVENTS.stockAdjusted,
          aggregateType: 'product',
          aggregateId: createdProduct._id,
          payload: {
            movementId: movement._id,
            productId: createdProduct._id,
            productName: createdProduct.name,
            stockBefore: 0,
            stockAfter: createdProduct.stockQuantity,
            quantityChange: createdProduct.stockQuantity,
            lowStockThreshold: createdProduct.lowStockThreshold,
            movementType: 'opening_stock'
          },
          dedupeKey: `${DOMAIN_EVENTS.stockAdjusted}:${movement._id}`
        },
        { session }
      );
    }

    return createdProduct;
  });

  emitProductChanges(req.business._id, 'product_created');
  void logAudit(req, { action: 'product.created', resourceType: 'product', resourceId: product._id, metadata: { name: product.name, stockQuantity: product.stockQuantity } });
  res.status(201).json({ success: true, product });
});

export const updateProduct = asyncHandler(async (req, res) => {
  const product = await withTransaction(async (session) => {
    const currentProduct = await Product.findOne({ _id: req.params.id, business: req.business._id }).session(session);

    if (!currentProduct) {
      throw new ApiError(404, 'Product not found');
    }

    const stockBefore = currentProduct.stockQuantity;
    const stockNotificationRelevant =
      req.body.stockQuantity !== undefined || req.body.lowStockThreshold !== undefined || req.body.trackStock !== undefined;
    Object.assign(currentProduct, productPayload(req.body), { updatedBy: req.user._id });
    await currentProduct.save({ session });

    const stockAfter = currentProduct.stockQuantity;
    if (stockNotificationRelevant) {
      let movement = null;
      if (currentProduct.trackStock !== false && req.body.stockQuantity !== undefined && stockAfter !== stockBefore) {
        [movement] = await StockMovement.create([{
          business: req.business._id,
          createdBy: req.user._id,
          product: currentProduct._id,
          type: 'manual_adjustment',
          quantityChange: stockAfter - stockBefore,
          stockBefore,
          stockAfter,
          note: 'Product stock edited manually'
        }], { session });
      }

      await publishDomainEvent(
        {
          business: req.business._id,
          actor: req.user._id,
          eventType: DOMAIN_EVENTS.stockAdjusted,
          aggregateType: 'product',
          aggregateId: currentProduct._id,
          payload: {
            movementId: movement?._id || null,
            productId: currentProduct._id,
            productName: currentProduct.name,
            stockBefore,
            stockAfter,
            quantityChange: stockAfter - stockBefore,
            lowStockThreshold: currentProduct.lowStockThreshold,
            trackStock: currentProduct.trackStock,
            movementType: movement ? 'manual_adjustment' : 'stock_settings_updated'
          },
          dedupeKey: `${DOMAIN_EVENTS.stockAdjusted}:${movement?._id || `${currentProduct._id}:${new Date(currentProduct.updatedAt || Date.now()).getTime()}`}`
        },
        { session }
      );
    }

    return currentProduct;
  });

  emitProductChanges(req.business._id, 'product_updated');
  void logAudit(req, { action: 'product.updated', resourceType: 'product', resourceId: product._id, metadata: { name: product.name, stockQuantity: product.stockQuantity } });
  res.json({ success: true, product });
});

export const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOneAndDelete({ _id: req.params.id, business: req.business._id });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  await publishDomainEvent({
    business: req.business._id,
    actor: req.user._id,
    eventType: DOMAIN_EVENTS.stockAdjusted,
    aggregateType: 'product',
    aggregateId: product._id,
    payload: {
      productId: product._id,
      productName: product.name,
      stockBefore: product.stockQuantity,
      stockAfter: null,
      quantityChange: 0,
      lowStockThreshold: product.lowStockThreshold,
      trackStock: false,
      movementType: 'product_deleted'
    },
    dedupeKey: `${DOMAIN_EVENTS.stockAdjusted}:${product._id}:deleted:${Date.now()}`
  });
  emitProductChanges(req.business._id, 'product_deleted');
  void logAudit(req, { action: 'product.deleted', resourceType: 'product', resourceId: product._id, metadata: { name: product.name } });
  res.json({ success: true, message: 'Product deleted' });
});

export const listProductStockMovements = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, business: req.business._id });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  const filter = { business: req.business._id, product: product._id };
  const query = StockMovement.find(filter).sort({ createdAt: -1 }).lean();
  const [summary = { quantitySold: 0, revenue: 0, orderCount: 0 }] = await Invoice.aggregate([
    { $match: { business: req.business._id, documentType: 'invoice', documentStatus: { $nin: ['cancelled', 'void'] }, 'items.product': product._id } },
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
      ? await Invoice.find({ _id: { $in: invoiceIds }, business: req.business._id, documentType: 'invoice' })
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
        documentNumber: movement.documentNumber || movement.invoiceNumber || invoice?.documentNumber || invoice?.invoiceNumber || '',
        documentType: movement.documentType || invoice?.documentType || '',
        documentStatus: invoice?.documentStatus || '',
        paymentStatus: invoice?.paymentStatus || '',
        fulfillmentStatus: invoice?.fulfillmentStatus || '',
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
        category: product.category,
        unit: product.unit,
        hsn: product.hsn,
        barcode: product.barcode,
      barcode: product.barcode,
        taxRate: product.taxRate,
        purchasePrice: product.purchasePrice,
        trackStock: product.trackStock,
        isActive: product.isActive
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
      category: product.category,
      unit: product.unit,
      hsn: product.hsn,
      barcode: product.barcode,
      taxRate: product.taxRate,
      purchasePrice: product.purchasePrice,
      trackStock: product.trackStock,
      isActive: product.isActive
    },
    summary,
    movements
  });
});
