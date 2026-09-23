const axios = require('axios');
const crypto = require('crypto');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');
const PlatformSetting = require('../../models/admin/PlatformSetting');
const { invalidateBrand } = require('../../services/brandService');

const PUBLIC_KEYS = [
  'platform_name',
  'platform_logo_url',
  'support_email',
  'support_phone',
  'platform_website',
  'default_currency',
  'default_country',
  'default_tax_rate',
  'tax_inclusive',
  'min_password_length',
  'registration_open',
  'maintenance_mode',
  'max_owners_per_tenant',
  'cashier_discount_limit',
  'cashier_refund_limit',
  'manager_can_invite_cashier',
  'require_shift_clock_in',
  'business_types',
  'countries',
  'currencies',
];

const FEATURE_KEYS = [
  'feature_pos',
  'feature_inventory',
  'feature_ai_insights',
  'feature_multi_location',
  'feature_loyalty',
  'feature_storefront',
  'feature_accounting',
  'feature_api',
  'feature_purchase_orders',
  'feature_invoices',
];

const AI_MASK = '••••••••';

const PROVIDER_DEFAULTS = [
  { key: 'hdm', label: 'HDM AI', baseUrl: 'https://hdmaiserver.pxxl.click/api/v1', apiKey: '', enabled: false },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', enabled: false },
  { key: 'chatgpt', label: 'ChatGPT (OpenAI)', baseUrl: 'https://api.openai.com/v1', apiKey: '', enabled: false },
  { key: 'claude', label: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com/v1', apiKey: '', enabled: false },
  { key: 'gemini', label: 'Gemini (Google)', baseUrl: 'https://generativelanguage.googleapis.com/v1', apiKey: '', enabled: false },
];

const VALID_DOWNLOAD_TYPES = ['windows', 'macos', 'linux', 'android', 'ios'];

const MPESA_DEFAULTS = {
  stkCheckoutEnabled: false,
};

// ── Core settings ───────────────────────────────────────

const get = asyncHandler(async (_req, res) => {
  const docs = await PlatformSetting.find().lean();
  const map = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  return ok(res, map);
});

const update = asyncHandler(async (req, res) => {
  const updates = req.body || {};
  const results = {};

  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith('feature_')) continue;
    await PlatformSetting.setValue(key, value, req.admin.id);
    results[key] = value;
  }

  invalidateBrand().catch(() => {});

  return ok(res, results);
});

const updateFeatures = asyncHandler(async (req, res) => {
  const updates = req.body || {};
  const results = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!key.startsWith('feature_')) continue;
    await PlatformSetting.setValue(key, Boolean(value), req.admin.id);
    results[key] = Boolean(value);
  }

  invalidateBrand().catch(() => {});

  return ok(res, results);
});

const getPublic = asyncHandler(async (_req, res) => {
  const docs = await PlatformSetting.find({ key: { $in: PUBLIC_KEYS } }).lean();
  const map = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  return ok(res, map);
});

const features = asyncHandler(async (_req, res) => {
  const docs = await PlatformSetting.find({ key: { $in: FEATURE_KEYS } }).lean();
  const map = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  return ok(res, map);
});

// ── AI ───────────────────────────────────────────────────

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return AI_MASK;
  return `${key.slice(0, 4)}${AI_MASK}${key.slice(-4)}`;
}

function maskProvider(p) {
  return {
    key: p.key,
    label: p.label,
    baseUrl: p.baseUrl || '',
    apiKey: p.apiKey ? maskKey(p.apiKey) : '',
    hasKey: Boolean(p.apiKey),
    enabled: p.enabled === true,
  };
}

async function loadAiConfig() {
  const doc = await PlatformSetting.findOne({ key: 'ai_config' }).lean();
  const stored = doc?.value && typeof doc.value === 'object' ? doc.value : {};

  const storedProviders = Array.isArray(stored.providers) ? stored.providers : [];
  const storedByKey = new Map(storedProviders.map((p) => [p.key, p]));

  const providers = PROVIDER_DEFAULTS.map((def) => {
    const existing = storedByKey.get(def.key);
    return {
      key: def.key,
      label: def.label,
      baseUrl: existing?.baseUrl ?? def.baseUrl,
      apiKey: existing?.apiKey ?? '',
      enabled: existing?.enabled === true,
    };
  });

  return {
    providers,
    defaultProvider: stored.defaultProvider || 'hdm',
    features: {
      landingAi: stored.features?.landingAi === true,
      clientAi: stored.features?.clientAi === true,
      fileUpload: stored.features?.fileUpload === true,
      outwardApiKeys: stored.features?.outwardApiKeys === true,
    },
  };
}

const getAi = asyncHandler(async (_req, res) => {
  const config = await loadAiConfig();
  return ok(res, {
    providers: config.providers.map(maskProvider),
    defaultProvider: config.defaultProvider,
    features: config.features,
  });
});

const updateAi = asyncHandler(async (req, res) => {
  const current = await loadAiConfig();
  const incoming = req.body || {};

  const incomingByKey = new Map((incoming.providers || []).map((p) => [p.key, p]));
  const currentByKey = new Map(current.providers.map((p) => [p.key, p]));

  const mergedProviders = PROVIDER_DEFAULTS.map((def) => {
    const incomingP = incomingByKey.get(def.key);
    const currentP = currentByKey.get(def.key);

    let apiKey = currentP?.apiKey || '';
    if (incomingP?.apiKey !== undefined) {
      if (incomingP.apiKey === '') {
        apiKey = '';
      } else if (!incomingP.apiKey.includes(AI_MASK)) {
        apiKey = incomingP.apiKey;
      }
    }

    return {
      key: def.key,
      label: def.label,
      baseUrl: incomingP?.baseUrl ?? currentP?.baseUrl ?? def.baseUrl,
      apiKey,
      enabled: incomingP?.enabled ?? currentP?.enabled ?? false,
    };
  });

  const next = {
    providers: mergedProviders,
    defaultProvider: incoming.defaultProvider || current.defaultProvider || 'hdm',
    features: {
      landingAi: incoming.features?.landingAi ?? current.features.landingAi,
      clientAi: incoming.features?.clientAi ?? current.features.clientAi,
      fileUpload: incoming.features?.fileUpload ?? current.features.fileUpload,
      outwardApiKeys: incoming.features?.outwardApiKeys ?? current.features.outwardApiKeys,
    },
  };

  await PlatformSetting.setValue('ai_config', next, req.admin.id);

  return ok(res, {
    providers: next.providers.map(maskProvider),
    defaultProvider: next.defaultProvider,
    features: next.features,
  });
});

const testAiProvider = asyncHandler(async (req, res) => {
  const config = await loadAiConfig();
  const { key } = req.params;

  const provider = config.providers.find((p) => p.key === key);
  if (!provider) throw ApiError.notFound('PROVIDER_NOT_FOUND', 'Provider not found');
  if (!provider.apiKey) throw ApiError.badRequest('NO_KEY', 'No API key configured');
  if (!provider.baseUrl) throw ApiError.badRequest('NO_URL', 'No base URL configured');

  const started = Date.now();
  try {
    const response = await axios.get(provider.baseUrl, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      timeout: 8000,
      validateStatus: () => true,
    });

    return ok(res, {
      key,
      reachable: true,
      status: response.status,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    throw ApiError.badRequest('UNREACHABLE', `Provider unreachable: ${err.message}`);
  }
});

// ── M-Pesa ──────────────────────────────────────────────

async function loadMpesaConfig() {
  const doc = await PlatformSetting.findOne({ key: 'mpesa_config' }).lean();
  const stored = doc?.value && typeof doc.value === 'object' ? doc.value : {};
  return {
    stkCheckoutEnabled: stored.stkCheckoutEnabled === true,
    updatedAt: doc?.updatedAt || null,
  };
}

const getMpesaConfig = asyncHandler(async (_req, res) => {
  const config = await loadMpesaConfig();
  return ok(res, config);
});

const updateMpesaConfig = asyncHandler(async (req, res) => {
  const incoming = req.body || {};
  const current = await loadMpesaConfig();

  const next = {
    stkCheckoutEnabled:
      typeof incoming.stkCheckoutEnabled === 'boolean'
        ? incoming.stkCheckoutEnabled
        : current.stkCheckoutEnabled,
  };

  await PlatformSetting.setValue('mpesa_config', next, req.admin.id);

  const saved = await loadMpesaConfig();
  return ok(res, saved);
});

// ── Downloads ───────────────────────────────────────────

function normalizeLink(link) {
  if (!link) return link;
  const trimmed = String(link).trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

async function loadDownloads() {
  const doc = await PlatformSetting.findOne({ key: 'downloads' }).lean();
  return Array.isArray(doc?.value) ? doc.value : [];
}

async function saveDownloads(list, adminId) {
  await PlatformSetting.setValue('downloads', list, adminId);
}

const getDownloads = asyncHandler(async (_req, res) => {
  const items = await loadDownloads();
  const sorted = [...items].sort((a, b) => (a.position || 0) - (b.position || 0));
  return ok(res, sorted);
});

const addDownload = asyncHandler(async (req, res) => {
  const { name, type, version, link } = req.body;

  if (!name || !type || !version || !link) {
    throw ApiError.badRequest('MISSING_FIELDS', 'name, type, version, link are required');
  }
  if (!VALID_DOWNLOAD_TYPES.includes(type)) {
    throw ApiError.badRequest('INVALID_TYPE', 'Invalid platform type');
  }

  const items = await loadDownloads();
  const id = crypto.randomUUID();
  const position = items.length;

  const item = {
    id,
    name: String(name).trim(),
    type,
    version: String(version).trim(),
    arch: req.body.arch || 'x64',
    link: normalizeLink(link),
    size: req.body.size || null,
    checksum: req.body.checksum || null,
    minOS: req.body.minOS || null,
    releaseNotes: req.body.releaseNotes || '',
    enabled: req.body.enabled !== false,
    position,
  };

  items.push(item);
  await saveDownloads(items, req.admin.id);

  return created(res, item);
});

const updateDownload = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const items = await loadDownloads();
  const idx = items.findIndex((d) => d.id === id);
  if (idx === -1) throw ApiError.notFound('DOWNLOAD_NOT_FOUND', 'Download not found');

  const allowed = ['name', 'type', 'version', 'arch', 'link', 'size', 'checksum', 'minOS', 'releaseNotes', 'enabled', 'position'];
  const entry = { ...items[idx] };

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      entry[key] = key === 'link' ? normalizeLink(req.body[key]) : req.body[key];
    }
  }

  if (entry.type && !VALID_DOWNLOAD_TYPES.includes(entry.type)) {
    throw ApiError.badRequest('INVALID_TYPE', 'Invalid platform type');
  }

  items[idx] = entry;
  await saveDownloads(items, req.admin.id);

  return ok(res, entry);
});

const toggleDownload = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const items = await loadDownloads();
  const idx = items.findIndex((d) => d.id === id);
  if (idx === -1) throw ApiError.notFound('DOWNLOAD_NOT_FOUND', 'Download not found');

  items[idx].enabled = !items[idx].enabled;
  await saveDownloads(items, req.admin.id);

  return ok(res, items[idx]);
});

const removeDownload = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const items = await loadDownloads();
  const before = items.length;
  const next = items.filter((d) => d.id !== id);

  if (next.length === before) {
    throw ApiError.notFound('DOWNLOAD_NOT_FOUND', 'Download not found');
  }

  next.forEach((d, i) => { d.position = i; });
  await saveDownloads(next, req.admin.id);

  return ok(res, { deleted: true });
});

const reorderDownloads = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) throw ApiError.badRequest('INVALID_INPUT', 'ids array required');

  const items = await loadDownloads();
  const map = new Map(items.map((d) => [d.id, d]));
  ids.forEach((id, i) => {
    const entry = map.get(id);
    if (entry) entry.position = i;
  });

  await saveDownloads(items, req.admin.id);

  return ok(res, items);
});

module.exports = {
  get,
  update,
  updateFeatures,
  getPublic,
  features,

  getAi,
  updateAi,
  testAiProvider,

  getMpesaConfig,
  updateMpesaConfig,

  getDownloads,
  addDownload,
  updateDownload,
  toggleDownload,
  removeDownload,
  reorderDownloads,
};