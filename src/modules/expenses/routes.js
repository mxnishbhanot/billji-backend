import { Router } from 'express';
import {
  createExpense,
  deleteExpense,
  expenseCategories,
  expenseQueryRules,
  expenseRules,
  getExpense,
  listExpenses,
  updateExpense
} from './controller.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Declared before '/:id' so 'categories' is never read as an expense id.
router.get('/categories', requirePermission(PERMISSIONS.expensesView), expenseCategories);
router.get('/', requirePermission(PERMISSIONS.expensesView), expenseQueryRules, validate, listExpenses);
router.post('/', requirePermission(PERMISSIONS.expensesManage), expenseRules, validate, idempotency(), createExpense);
router.get('/:id', requirePermission(PERMISSIONS.expensesView), getExpense);
router.patch('/:id', requirePermission(PERMISSIONS.expensesManage), expenseRules, validate, updateExpense);
router.delete('/:id', requirePermission(PERMISSIONS.expensesManage), deleteExpense);

export default router;
