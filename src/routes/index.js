import { Router } from 'express';
import auditRoutes from './auditRoutes.js';
import authRoutes from './authRoutes.js';
import customerRoutes from './customerRoutes.js';
import draftRoutes from './draftRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import ledgerRoutes from './ledgerRoutes.js';
import notificationRoutes from './notificationRoutes.js';
import orderRoutes from './orderRoutes.js';
import paymentRoutes from './paymentRoutes.js';
import productRoutes from './productRoutes.js';
import publicRoutes from './publicRoutes.js';
import reportRoutes from './reportRoutes.js';
import settingsRoutes from './settingsRoutes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/products', productRoutes);
router.use('/customers', customerRoutes);
router.use('/drafts', draftRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/ledger', ledgerRoutes);
router.use('/notifications', notificationRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/public', publicRoutes);
router.use('/reports', reportRoutes);
router.use('/settings', settingsRoutes);

export default router;
