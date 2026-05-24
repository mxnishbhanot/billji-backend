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
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', customerQueryRules, validate, listCustomers);
router.post('/', customerRules, validate, createCustomer);
router.patch('/:id', customerRules, validate, updateCustomer);
router.delete('/:id', deleteCustomer);

export default router;
