const { Router } = require('express');
const { clientAuth } = require('../../middleware/client/clientAuth');
const { tenantScope } = require('../../middleware/client/tenantScope');

const authRoutes = require('./authRoutes');
const profileRoutes = require('./profileRoutes');
const productRoutes = require('./productRoutes');
const saleRoutes = require('./saleRoutes');
const paymentRoutes = require('./paymentRoutes');
const customerRoutes = require('./customerRoutes');
const inventoryRoutes = require('./inventoryRoutes');
const categoryRoutes = require('./categoryRoutes');
const userRoutes = require('./userRoutes');
const invitationRoutes = require('./invitationRoutes');
const settingsRoutes = require('./settingsRoutes');
const insightRoutes = require('./insightRoutes');
const reportRoutes = require('./reportRoutes');
const receiptRoutes = require('./receiptRoutes');
const chatRoutes = require('./chatRoutes');
const supplierRoutes = require('./supplierRoutes');
const billingRoutes = require('./billingRoutes');
const externalKeyRoutes = require('./externalKeyRoutes');
const heldSaleRoutes = require('./heldSaleRoutes');
const purchaseOrderRoutes = require('./purchaseOrderRoutes');
const invoiceRoutes = require('./invoiceRoutes');
const syncRoutes = require('../../sync/syncRoutes');

const router = Router();

router.use(clientAuth, tenantScope);

router.use('/auth', authRoutes);
router.use('/profile', profileRoutes);
router.use('/products', productRoutes);
router.use('/categories', categoryRoutes);
router.use('/sales', saleRoutes);
router.use('/payments', paymentRoutes);
router.use('/customers', customerRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/users', userRoutes);
router.use('/invitations', invitationRoutes);
router.use('/settings', settingsRoutes);
router.use('/insights', insightRoutes);
router.use('/reports', reportRoutes);
router.use('/receipts', receiptRoutes);
router.use('/chat', chatRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/billing', billingRoutes);
router.use('/external-keys', externalKeyRoutes);
router.use('/held-sales', heldSaleRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/sync', syncRoutes);

module.exports = router;