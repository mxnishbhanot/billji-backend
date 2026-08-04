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
import { FEATURES } from '../../constants/entitlements.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { requireFeature } from '../../middlewares/entitlement.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Expenses are a paid feature in full, reads included: a plan that does not include the module
// does not include looking at it either. Declared after requirePermission on every route so a
// staff member without the permission is told that, and never shown a paywall for a module they
// could not use anyway.
const expensesFeature = requireFeature(FEATURES.expenses);

// Declared before '/:id' so 'categories' is never read as an expense id.
router.get('/categories', requirePermission(PERMISSIONS.expensesView), expensesFeature, expenseCategories);
router.get('/', requirePermission(PERMISSIONS.expensesView), expensesFeature, expenseQueryRules, validate, listExpenses);
router.post('/', requirePermission(PERMISSIONS.expensesManage), expensesFeature, expenseRules, validate, idempotency(), createExpense);
router.get('/:id', requirePermission(PERMISSIONS.expensesView), expensesFeature, getExpense);
router.patch('/:id', requirePermission(PERMISSIONS.expensesManage), expensesFeature, expenseRules, validate, updateExpense);
router.delete('/:id', requirePermission(PERMISSIONS.expensesManage), expensesFeature, deleteExpense);

export default router;
