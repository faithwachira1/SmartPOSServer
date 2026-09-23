const { asyncHandler } = require('../../utils/asyncHandler');
const { ok } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');
const { logger } = require('../../utils/logger');
const crypto = require('../../utils/crypto');
const cacheService = require('../../services/cacheService');
const mpesaService = require('../../services/mpesaService');
const Tenant = require('../../models/admin/Tenant');
const PaymentMethod = require('../../models/admin/PaymentMethod');
const PlatformSetting = require('../../models/admin/PlatformSetting');

async function loadAiFeatures() {
  const doc = await PlatformSetting.findOne({ key: 'ai_config' }).lean();
  const features = doc?.value?.features ?? {};
  return {
    clientAi: features.clientAi === true,
    fileUpload: features.fileUpload === true,
    outwardApiKeys: features.outwardApiKeys === true,
  };
}

async function loadPlatformMpesaConfig() {
  const doc = await PlatformSetting.findOne({ key: 'mpesa_config' }).lean();
  const stored = doc?.value && typeof doc.value === 'object' ? doc.value : {};
  return {
    stkCheckoutEnabled: stored.stkCheckoutEnabled === true,
  };
}

const VALID_DISCOUNT_TYPES = [
  'fixed',
  'percent',
  'buy_one_get_one',
  'buy_x_get_y',
];

function sanitizeSpecificDiscounts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const d of input) {
    if (!d || typeof d !== 'object') continue;
    const type = VALID_DISCOUNT_TYPES.includes(d.type) ? d.type : 'fixed';
    const name = String(d.name || '').trim();
    const productIds = Array.isArray(d.productIds) ? d.productIds.map(String) : [];
    const value = Number(d.value) || 0;
    const buyQuantity = Math.max(1, Number(d.buyQuantity) || 1);
    const getQuantity = Math.max(1, Number(d.getQuantity) || 1);
    const getProductId = d.getProductId ? String(d.getProductId) : null;

    out.push({
      name,
      type,
      value,
      productIds,
      buyQuantity,
      getQuantity,
      getProductId,
    });
  }
  return out;
}

const get = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.tenantId).lean();
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const availableMethods = await PaymentMethod.find({ enabled: true })
    .sort({ order: 1 })
    .select('code label')
    .lean();

  const enabledForTenant = tenant.settings?.paymentMethods || [];
  const aiFeatures = await loadAiFeatures();

  return ok(res, {
    settings: tenant.settings || {},
    paymentMethods: availableMethods,
    enabledPaymentMethods: enabledForTenant,
    aiFeatures,
  });
});

const update = asyncHandler(async (req, res) => {
  const allowed = [
    'currency',
    'taxEnabled',
    'taxRate',
    'taxInclusive',
    'discountEnabled',
    'discountLabel',
    'discountRate',
    'loyaltyEnabled',
    'loyaltyPointsPerAmount',
    'loyaltyLabel',
    'receiptTemplate',
    'receiptFooter',
  ];
  const patch = {};

  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[`settings.${k}`] = req.body[k];
  }

  if (req.body.specificDiscounts !== undefined) {
    patch['settings.specificDiscounts'] = sanitizeSpecificDiscounts(
      req.body.specificDiscounts
    );
  }

  if (!Object.keys(patch).length) {
    throw ApiError.badRequest('NO_CHANGES', 'No valid fields');
  }

  const tenant = await Tenant.findByIdAndUpdate(
    req.tenantId,
    { $set: patch },
    { new: true }
  ).lean();

  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');
  return ok(res, tenant.settings);
});

const enablePayment = asyncHandler(async (req, res) => {
  const { code } = req.params;

  const method = await PaymentMethod.findOne({ code, enabled: true }).lean();
  if (!method) throw ApiError.badRequest('METHOD_UNAVAILABLE', 'Payment method not available');

  const tenant = await Tenant.findById(req.tenantId);
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const list = new Set(tenant.settings?.paymentMethods || []);
  list.add(code);
  tenant.settings = { ...tenant.settings, paymentMethods: Array.from(list) };
  await tenant.save();

  return ok(res, { enabledPaymentMethods: Array.from(list) });
});

const disablePayment = asyncHandler(async (req, res) => {
  const { code } = req.params;

  const tenant = await Tenant.findById(req.tenantId);
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const list = (tenant.settings?.paymentMethods || []).filter((c) => c !== code);
  tenant.settings = { ...tenant.settings, paymentMethods: list };
  await tenant.save();

  return ok(res, { enabledPaymentMethods: list });
});

const getMpesa = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.tenantId).lean();
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const s = tenant.settings || {};
  const m = s.mpesa || {};
  const platform = await loadPlatformMpesaConfig();

  const safeMask = (enc) => {
    if (!enc) return '';
    try {
      return crypto.maskSecret(crypto.decrypt(enc));
    } catch {
      return '••••';
    }
  };

  const configured = Boolean(
    m.shortcode && m.consumerKeyEnc && m.consumerSecretEnc && m.passkeyEnc
  );

  return ok(res, {
    enabled: s.mpesaStkEnabled === true,
    platformEnabled: platform.stkCheckoutEnabled,
    effectivelyEnabled:
      platform.stkCheckoutEnabled && s.mpesaStkEnabled === true,
    env: m.env || 'sandbox',
    shortcode: m.shortcode || '',
    consumerKey: safeMask(m.consumerKeyEnc),
    consumerSecret: safeMask(m.consumerSecretEnc),
    passkey: safeMask(m.passkeyEnc),
    configured,
    updatedAt: m.updatedAt || null,
  });
});

const updateMpesa = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const tenant = await Tenant.findById(req.tenantId);
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const platform = await loadPlatformMpesaConfig();
  const current = tenant.settings?.mpesa || {};
  const currentEnabled = tenant.settings?.mpesaStkEnabled === true;

  const enabled =
    typeof body.enabled === 'boolean' ? body.enabled : currentEnabled;

  if (enabled && !platform.stkCheckoutEnabled) {
    throw ApiError.forbidden(
      'PLATFORM_STK_DISABLED',
      'M-Pesa STK checkout is disabled by the platform administrator'
    );
  }

  const env =
    body.env === 'production' || body.env === 'sandbox'
      ? body.env
      : current.env || 'sandbox';

  const shortcode =
    typeof body.shortcode === 'string'
      ? body.shortcode.trim()
      : current.shortcode || '';

  const resolveSecret = (incoming, existing) => {
    if (incoming === undefined) return existing || '';
    if (incoming === null || incoming === '') return '';
    if (crypto.isMasked(incoming)) return existing || '';
    return crypto.encrypt(String(incoming).trim());
  };

  const consumerKeyEnc = resolveSecret(body.consumerKey, current.consumerKeyEnc);
  const consumerSecretEnc = resolveSecret(
    body.consumerSecret,
    current.consumerSecretEnc
  );
  const passkeyEnc = resolveSecret(body.passkey, current.passkeyEnc);

  if (enabled) {
    if (!shortcode) {
      throw ApiError.badRequest(
        'MPESA_SHORTCODE_MISSING',
        'Shortcode is required to enable STK checkout'
      );
    }
    if (!consumerKeyEnc || !consumerSecretEnc || !passkeyEnc) {
      throw ApiError.badRequest(
        'MPESA_CREDS_MISSING',
        'Consumer key, consumer secret and passkey are all required to enable STK checkout'
      );
    }
  }

  const credsChanged =
    consumerKeyEnc !== current.consumerKeyEnc ||
    consumerSecretEnc !== current.consumerSecretEnc ||
    passkeyEnc !== current.passkeyEnc ||
    shortcode !== current.shortcode ||
    env !== current.env;

  const now = new Date();
  tenant.settings = {
    ...(tenant.settings || {}),
    mpesaStkEnabled: enabled,
    mpesa: {
      env,
      shortcode,
      consumerKeyEnc,
      consumerSecretEnc,
      passkeyEnc,
      updatedAt: now,
      updatedBy: req.user?.id || null,
    },
  };
  tenant.markModified('settings');
  await tenant.save();

  if (credsChanged) {
    await cacheService.del(`mpesa:token:${req.tenantId}`);
  }

  logger.info(
    { tenantId: req.tenantId, enabled, env, shortcode, credsChanged },
    'mpesa settings updated'
  );

  const safeMask = (enc) => {
    if (!enc) return '';
    try {
      return crypto.maskSecret(crypto.decrypt(enc));
    } catch {
      return '••••';
    }
  };

  return ok(res, {
    enabled,
    platformEnabled: platform.stkCheckoutEnabled,
    effectivelyEnabled: platform.stkCheckoutEnabled && enabled,
    env,
    shortcode,
    consumerKey: safeMask(consumerKeyEnc),
    consumerSecret: safeMask(consumerSecretEnc),
    passkey: safeMask(passkeyEnc),
    configured: Boolean(shortcode && consumerKeyEnc && consumerSecretEnc && passkeyEnc),
    updatedAt: now,
  });
});

const testMpesa = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.tenantId).lean();
  const m = tenant?.settings?.mpesa;
  if (!m?.consumerKeyEnc || !m?.consumerSecretEnc || !m?.passkeyEnc || !m?.shortcode) {
    throw ApiError.badRequest(
      'MPESA_CREDS_MISSING',
      'Save your credentials before testing'
    );
  }

  try {
    const creds = {
      env: m.env || 'sandbox',
      consumerKey: crypto.decrypt(m.consumerKeyEnc),
      consumerSecret: crypto.decrypt(m.consumerSecretEnc),
      shortcode: m.shortcode,
      passkey: crypto.decrypt(m.passkeyEnc),
    };
    await mpesaService.getAccessToken(creds);
    return ok(res, { ok: true, environment: creds.env });
  } catch (err) {
    return ok(res, { ok: false, error: err.message });
  }
});

module.exports = {
  get,
  update,
  enablePayment,
  disablePayment,
  getMpesa,
  updateMpesa,
  testMpesa,
};