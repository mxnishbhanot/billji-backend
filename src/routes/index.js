import { Router } from 'express';
import authRoutes from './authRoutes.js';
import customerRoutes from './customerRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import notificationRoutes from './notificationRoutes.js';
import productRoutes from './productRoutes.js';
import publicRoutes from './publicRoutes.js';
import reportRoutes from './reportRoutes.js';
import settingsRoutes from './settingsRoutes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/customers', customerRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/notifications', notificationRoutes);
router.use('/public', publicRoutes);
router.use('/reports', reportRoutes);
router.use('/settings', settingsRoutes);

export default router;
