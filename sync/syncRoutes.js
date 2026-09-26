const { Router } = require('express');
const engine = require('./syncEngine');
const { syncGuard, deviceLimiter } = require('./syncGuard');
const { requireActive } = require('../middleware/client/statusGuard');

const router = Router();

// Register device does NOT need syncGuard (device isn't registered yet)
router.post('/register-device', requireActive, engine.registerDevice);

// Guarded routes
router.use(requireActive);
router.use(deviceLimiter);
router.use(syncGuard);

router.get('/pull', engine.pull);
router.post('/push', engine.push);

module.exports = router;