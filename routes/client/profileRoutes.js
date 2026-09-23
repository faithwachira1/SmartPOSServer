const { Router } = require('express');
const c = require('../../controllers/client/profileController');
const { roles } = require('../../middleware/client/roles');
const { uploadSingle } = require('../../middleware/global/upload');

const router = Router();

router.get('/', c.get);
router.patch('/', roles('owner', 'manager'), c.update);
router.patch('/me', c.updateMe);
router.post('/logo', roles('owner', 'manager'), uploadSingle, c.uploadLogo);

module.exports = router;