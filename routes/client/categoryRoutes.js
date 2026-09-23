const { Router } = require('express');
const c = require('../../controllers/client/categoryController');
const { roles } = require('../../middleware/client/roles');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);

router.get('/', c.list);
router.post('/', roles('owner', 'manager'), c.create);
router.patch('/reorder', roles('owner', 'manager'), c.reorder);
router.get('/:id', c.getOne);
router.patch('/:id', roles('owner', 'manager'), c.update);
router.delete('/:id', roles('owner', 'manager'), c.remove);

module.exports = router;