const crypto = require('crypto');
const ExternalKey = require('../../models/client/ExternalKey');
const Tenant = require('../../models/admin/Tenant');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiError } = require('../../utils/apiError');

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function extractKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();

  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey) return headerKey.trim();

  return null;
}

const externalKeyAuth = asyncHandler(async (req, _res, next) => {
  const raw = extractKey(req);
  if (!raw || !raw.startsWith('sp_live_')) {
    throw ApiError.unauthorized('MISSING_KEY', 'External API key required');
  }

  const keyHash = hashKey(raw);
  const record = await ExternalKey.findOne({ keyHash }).lean();

  if (!record) {
    throw ApiError.unauthorized('INVALID_KEY', 'Invalid API key');
  }

  const tenant = await Tenant.findById(record.tenantId).lean();
  if (!tenant) {
    throw ApiError.unauthorized('TENANT_NOT_FOUND', 'Tenant not found');
  }
  if (tenant.status !== 'active') {
    throw ApiError.forbidden('TENANT_INACTIVE', 'Tenant account is not active');
  }

  req.tenantId = record.tenantId;
  req.externalKey = { id: record._id, prefix: record.prefix };

  ExternalKey.updateOne(
    { _id: record._id },
    { $set: { lastUsedAt: new Date() } }
  ).catch(() => {});

  next();
});

module.exports = { externalKeyAuth };