const { Router } = require('express');
const c = require('../../controllers/client/invoiceController');
const { roles } = require('../../middleware/client/roles');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);

router.get('/', c.list);
router.post('/', roles('owner', 'manager'), c.create);
router.get('/:id', c.get);
router.patch('/:id', roles('owner', 'manager'), c.update);
router.post('/:id/send', roles('owner', 'manager'), c.send);
router.post('/:id/payment', roles('owner', 'manager'), c.recordPayment);
router.post('/:id/cancel', roles('owner', 'manager'), c.cancel);
router.post('/:id/remind', roles('owner', 'manager'), c.remind);
router.get('/:id/pdf', c.pdf);

module.exports = router;