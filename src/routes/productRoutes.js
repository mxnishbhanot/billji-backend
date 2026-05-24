import { Router } from 'express';
import {
  createProduct,
  deleteProduct,
  listProductStockMovements,
  listProducts,
  productQueryRules,
  productRules,
  updateProduct
} from '../controllers/productController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', productQueryRules, validate, listProducts);
router.post('/', productRules, validate, createProduct);
router.get('/:id/stock-movements', listProductStockMovements);
router.patch('/:id', productRules, validate, updateProduct);
router.delete('/:id', deleteProduct);

export default router;
