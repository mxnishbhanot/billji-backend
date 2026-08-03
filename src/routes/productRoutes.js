import { Router } from 'express';
import {
  createProduct,
  deleteProduct,
  listProductCategories,
  listProductStockMovements,
  listProducts,
  productQueryRules,
  productRules,
  updateProduct
} from '../controllers/productController.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { idempotency } from '../middlewares/idempotency.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.productsView), productQueryRules, validate, listProducts);
router.post('/', requirePermission(PERMISSIONS.productsManage), productRules, validate, idempotency(), createProduct);
router.get('/categories', requirePermission(PERMISSIONS.productsView), listProductCategories);
router.get('/:id/stock-movements', requirePermission(PERMISSIONS.productsView), listProductStockMovements);
router.patch('/:id', requirePermission(PERMISSIONS.productsManage), productRules, validate, idempotency(), updateProduct);
router.delete('/:id', requirePermission(PERMISSIONS.productsManage), idempotency(), deleteProduct);

export default router;
