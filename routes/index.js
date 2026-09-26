const { Router } = require('express');

const publicRoutes = require('./public');
const adminRoutes = require('./admin');
const clientRoutes = require('./client');
const externalRoutes = require('./external');

const router = Router();

// Public health — no auth, no DB. Used by the desktop sync engine.
router.get('/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

router.use('/public', publicRoutes);
router.use('/admin', adminRoutes);
router.use('/client', clientRoutes);
router.use('/external', externalRoutes);

module.exports = router;