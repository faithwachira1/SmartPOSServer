const { Router } = require('express');
const c = require('../../controllers/client/billingController');
const { roles } = require('../../middleware/client/roles');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);
router.use(roles('owner'));

router.get('/subscription', c.getSubscription);
router.get('/payments', c.listPayments);

module.exports = router;