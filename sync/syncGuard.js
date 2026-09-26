const rateLimit = require('express-rate-limit');
const Device = require('./models/Device');
const { asyncHandler } = require('../utils/asyncHandler');
const { ApiError } = require('../utils/apiError');

const deviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const deviceId =
      req.body?.deviceId || req.query?.deviceId || req.headers['x-device-id'];
    return `device:${deviceId || req.ip}`;
  },
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many sync requests' },
  },
});

const syncGuard = asyncHandler(async (req, _res, next) => {
  const deviceId =
    req.body?.deviceId || req.query?.deviceId || req.headers['x-device-id'];
  const branchId =
    req.body?.branchId || req.query?.branchId || req.headers['x-branch-id'];

  if (!deviceId || typeof deviceId !== 'string') {
    throw ApiError.badRequest('MISSING_DEVICE', 'deviceId is required');
  }
  if (!branchId) {
    throw ApiError.badRequest('MISSING_BRANCH', 'branchId is required');
  }

  const device = await Device.findOne({
    tenantId: req.tenantId,
    deviceId,
  }).lean();

  if (!device) {
    throw ApiError.unauthorized('DEVICE_NOT_REGISTERED', 'Device not registered');
  }
  if (device.blocked) {
    throw ApiError.forbidden('DEVICE_BLOCKED', device.blockReason || 'Device is blocked');
  }
  if (String(device.branchId) !== String(branchId)) {
    throw ApiError.forbidden(
      'BRANCH_MISMATCH',
      'Device does not belong to this branch'
    );
  }

  req.device = device;
  req.branchId = device.branchId;

  Device.updateOne(
    { _id: device._id },
    { $set: { lastSeenAt: new Date() } }
  ).catch(() => {});

  next();
});

module.exports = { syncGuard, deviceLimiter };