const { Router } = require('express');
const c = require('../../controllers/client/heldSaleController');
const { roles } = require('../../middleware/client/roles');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);
router.use(roles('owner', 'manager', 'cashier'));

router.get('/', c.list);
router.post('/', c.create);
router.get('/:id', c.get);
router.delete('/:id', c.remove);

module.exports = router;