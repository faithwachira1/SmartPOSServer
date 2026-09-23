const { Router } = require('express');
const c = require('../../controllers/client/purchaseOrderController');
const { roles } = require('../../middleware/client/roles');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);

router.get('/', c.list);
router.post('/', roles('owner', 'manager'), c.create);
router.get('/:id', c.get);
router.patch('/:id', roles('owner', 'manager'), c.update);
router.post('/:id/send', roles('owner', 'manager'), c.send);
router.post('/:id/receive', roles('owner', 'manager'), c.receive);
router.post('/:id/cancel', roles('owner', 'manager'), c.cancel);
router.delete('/:id', roles('owner', 'manager'), c.remove);

module.exports = router;