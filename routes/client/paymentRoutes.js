const { Router } = require('express');
const c = require('../../controllers/client/paymentController');
const { requireActive } = require('../../middleware/client/statusGuard');

const router = Router();

router.use(requireActive);

router.post('/stk', c.initiateStk);
router.get('/stk/:checkoutRequestId', c.checkStkStatus);
router.delete('/stk/:checkoutRequestId', c.cancelStk);

module.exports = router;