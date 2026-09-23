const { Router } = require('express');
const c = require('../../controllers/client/reportController');
const { roles } = require('../../middleware/client/roles');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);

// Available to all roles (cashiers included)
router.get('/sales', c.salesSummary);
router.get('/top-products', c.topProducts);
router.get('/inventory', c.inventory);

// Manager / owner only
router.get('/staff', roles('owner', 'manager'), c.staff);
router.get('/customers', roles('owner', 'manager'), c.customers);
router.get('/suppliers', roles('owner', 'manager'), c.suppliers);
router.get('/general', roles('owner', 'manager'), c.general);

// CSV export (existing)
router.get('/export', roles('owner', 'manager'), c.exportData);

module.exports = router;