const { Router } = require('express');
const c = require('../../controllers/client/externalKeyController');
const { roles } = require('../../middleware/client/roles');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);
router.use(roles('owner'));

router.get('/', c.getKey);
router.post('/', c.createKey);
router.delete('/', c.revokeKey);

module.exports = router;