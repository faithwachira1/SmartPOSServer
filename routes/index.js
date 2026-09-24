const { Router } = require('express');

const publicRoutes = require('./public');
const adminRoutes = require('./admin');
const clientRoutes = require('./client');
const externalRoutes = require('./external');

const router = Router();

router.use('/public', publicRoutes);
router.use('/admin', adminRoutes);
router.use('/client', clientRoutes);
router.use('/external', externalRoutes);

module.exports = router;