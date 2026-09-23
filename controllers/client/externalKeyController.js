const crypto = require('crypto');
const ExternalKey = require('../../models/client/ExternalKey');
const PlatformSetting = require('../../models/admin/PlatformSetting');
const Product = require('../../models/client/Product');
const Category = require('../../models/client/Category');
const Customer = require('../../models/client/Customer');
const Sale = require('../../models/client/Sale');
const Tenant = require('../../models/admin/Tenant');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');

function generateRawKey() {
  return `sp_live_${crypto.randomBytes(16).toString('hex')}`;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function ensureAdminAllows() {
  const doc = await PlatformSetting.findOne({ key: 'ai_config' }).lean();
  const allowed = doc?.value?.features?.outwardApiKeys === true;
  if (!allowed) {
    throw ApiError.forbidden(
      'OUTWARD_KEYS_DISABLED',
      'Outward API keys are disabled by the platform admin'
    );
  }
}

const getKey = asyncHandler(async (req, res) => {
  const record = await ExternalKey.findOne({ tenantId: req.tenantId }).lean();

  if (!record) return ok(res, null);

  return ok(res, {
    id: record._id,
    name: record.name || 'Default key',
    prefix: record.prefix,
    lastUsedAt: record.lastUsedAt || null,
    createdAt: record.createdAt,
  });
});

const createKey = asyncHandler(async (req, res) => {
  await ensureAdminAllows();

  const name = String(req.body?.name || '').trim() || 'Default key';

  const existing = await ExternalKey.findOne({ tenantId: req.tenantId });
  if (existing) {
    throw ApiError.conflict(
      'KEY_EXISTS',
      'A key already exists. Revoke it first to generate a new one.'
    );
  }

  const raw = generateRawKey();
  const keyHash = hashKey(raw);
  const prefix = raw.slice(0, 16);

  const record = await ExternalKey.create({
    tenantId: req.tenantId,
    keyHash,
    prefix,
    name,
  });

  return created(res, {
    id: record._id,
    name: record.name,
    prefix: record.prefix,
    key: raw,
    createdAt: record.createdAt,
  });
});

const revokeKey = asyncHandler(async (req, res) => {
  const record = await ExternalKey.findOne({ tenantId: req.tenantId });
  if (!record) throw ApiError.notFound('NO_KEY', 'No key to revoke');

  await ExternalKey.deleteOne({ _id: record._id });

  return ok(res, { revoked: true });
});

const fetchAll = asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const [products, categories, customers, sales] = await Promise.all([
    Product.find({ tenantId, active: true })
      .select('sku name barcode price stock category updatedAt')
      .sort({ name: 1 })
      .lean(),
    Category.find({ tenantId }).sort({ position: 1, name: 1 }).lean(),
    Customer.find({ tenantId }).sort({ createdAt: -1 }).lean(),
    Sale.find({ tenantId, voided: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean(),
  ]);

  return ok(res, {
    store: {
      id: tenant._id,
      name: tenant.name,
      slug: tenant.slug,
      currency: tenant.settings?.currency || 'KES',
      timezone: tenant.settings?.timezone || 'Africa/Nairobi',
    },
    products,
    categories,
    customers,
    sales,
    generatedAt: new Date().toISOString(),
  });
});

module.exports = { getKey, createKey, revokeKey, fetchAll };