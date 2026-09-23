const { Router } = require('express');
const c = require('../../controllers/admin/settingsController');

const router = Router();

router.get('/', c.get);
router.patch('/', c.update);
router.get('/public', c.getPublic);
router.get('/features', c.features);
router.patch('/features', c.updateFeatures);

router.get('/ai', c.getAi);
router.patch('/ai', c.updateAi);
router.post('/ai/test/:key', c.testAiProvider);

router.get('/mpesa', c.getMpesaConfig);
router.patch('/mpesa', c.updateMpesaConfig);

router.get('/downloads', c.getDownloads);
router.post('/downloads', c.addDownload);
router.patch('/downloads/reorder', c.reorderDownloads);
router.patch('/downloads/:id', c.updateDownload);
router.post('/downloads/:id/toggle', c.toggleDownload);
router.delete('/downloads/:id', c.removeDownload);

module.exports = router;