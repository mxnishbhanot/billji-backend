import { Router } from 'express';
import { cancelOrder, createOrder, generateInvoiceFromOrder, getOrder, listOrders } from './controller.js';
import { orderQueryRules, orderRules } from './schema.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.ordersView), orderQueryRules, validate, listOrders);
router.post('/', requirePermission(PERMISSIONS.ordersCreate), orderRules, validate, idempotency(), createOrder);
router.get('/:id', requirePermission(PERMISSIONS.ordersView), getOrder);
router.post('/:id/generate-invoice', requirePermission(PERMISSIONS.ordersManage), idempotency(), generateInvoiceFromOrder);
router.post('/:id/cancel', requirePermission(PERMISSIONS.ordersManage), idempotency(), cancelOrder);

export default router;
