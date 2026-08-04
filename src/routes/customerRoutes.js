import { Router } from 'express';
import {
  createCustomer,
  customerQueryRules,
  customerRules,
  deleteCustomer,
  listCustomers,
  updateCustomer
} from '../controllers/customerController.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { idempotency } from '../middlewares/idempotency.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.customersView), customerQueryRules, validate, listCustomers);
router.post('/', requirePermission(PERMISSIONS.customersManage), customerRules, validate, idempotency(), createCustomer);
router.patch('/:id', requirePermission(PERMISSIONS.customersManage), customerRules, validate, idempotency(), updateCustomer);
router.delete('/:id', requirePermission(PERMISSIONS.customersManage), idempotency(), deleteCustomer);

export default router;
