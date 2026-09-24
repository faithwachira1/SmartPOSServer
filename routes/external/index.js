const { Router } = require('express');
const { externalKeyAuth } = require('../../middleware/client/externalKeyAuth');
const c = require('../../controllers/client/externalKeyController');

const router = Router();

router.use(externalKeyAuth);

router.get('/data', c.fetchAll);

module.exports = router;