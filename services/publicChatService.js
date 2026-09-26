const { chat } = require('./aiService');
const PlatformSetting = require('../models/admin/PlatformSetting');
const Plan = require('../models/admin/Plan');
const cacheService = require('./cacheService');
const { getRedis } = require('../config/redis');
const { logger } = require('../utils/logger');

const RATE_LIMIT_PER_IP = 30;
const WINDOW_SEC = 3600;
const PROMPT_CACHE_KEY = 'chat:public:system_prompt';
const PROMPT_TTL = 300;

const FEATURE_LABELS = {
  pos: 'Point of sale — fast checkout with keyboard shortcuts',
  inventory: 'Real-time inventory tracking and adjustments',
  barcode_scanning: 'Barcode scanner support (USB keyboard-wedge)',
  receipts: 'Print, email, or share thermal receipts and PDF invoices',
  reports: 'Sales, staff, and product reports with CSV export',
  customer_management: 'Customer profiles, purchase history, and contact info',
  supplier_management: 'Supplier directory with order history',
  purchase_orders: 'Create, send, and receive purchase orders',
  invoices: 'Generate and send invoices with payment tracking',
  multi_user: 'Multiple staff accounts with owner, manager, and cashier roles',
  multi_currency: 'Multi-currency support (KES, USD, EUR, GBP)',
  mpesa: 'M-Pesa payments — STK Push, Send Money, Paybill, and Till',
  stripe: 'Card payments via Stripe',
  paypal: 'PayPal payments',
  bank_transfer: 'Bank transfer payment option',
  low_stock_alerts: 'Automatic low-stock notifications',
  sales_insights: 'AI-powered sales insights and trends',
  ai_insights: 'AI assistant that answers questions about your business',
  offline_desktop:
    'Desktop app works fully offline — cashiers keep selling when the internet drops, sales save locally, and data syncs automatically when the connection returns',
  multi_location: 'Manage multiple store locations from one account',
  loyalty: 'Customer loyalty program with points and rewards',
  storefront: 'Online storefront for customers to browse and order',
  accounting: 'Accounting integration and expense tracking',
  api: 'External API access for integrations',
};

function label(key) {
  if (FEATURE_LABELS[key]) return FEATURE_LABELS[key];
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function isLandingAiEnabled() {
  const doc = await PlatformSetting.findOne({ key: 'ai_config' }).lean();
  return doc?.value?.features?.landingAi === true;
}

async function buildSystemPrompt() {
  const cached = await cacheService.get(PROMPT_CACHE_KEY);
  if (cached) return cached;

  const [platformName, supportEmail, supportPhone, website] = await Promise.all([
    PlatformSetting.getValue('platform_name', 'SmartPOS'),
    PlatformSetting.getValue('support_email', null),
    PlatformSetting.getValue('support_phone', null),
    PlatformSetting.getValue('platform_website', null),
  ]);

  const features = await PlatformSetting.find({ key: /^feature_/ }).lean();
  const on = features
    .filter((f) => f.value === true)
    .map((f) => f.key.replace('feature_', ''));
  const off = features
    .filter((f) => f.value !== true)
    .map((f) => f.key.replace('feature_', ''));

  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean();

  const lines = [];
  lines.push(
    `You are the AI assistant on ${platformName}'s landing page. ${platformName} is a point-of-sale platform for small businesses, especially in Africa.`
  );
  lines.push('');

  lines.push('## Available features');
  lines.push('');
  for (const f of on) lines.push(`- ${label(f)}`);
  lines.push('');

  if (off.length) {
    lines.push('## Not yet available (never promise these)');
    lines.push('');
    for (const f of off) lines.push(`- ${label(f)}`);
    lines.push('');
  }

  if (plans.length) {
    lines.push('## Pricing');
    lines.push('');
    for (const p of plans) {
      const price = p.price?.amount
        ? `${p.price.amount} ${p.price.currency}/${p.price.interval}`
        : 'Free';
      lines.push(
        `- ${p.name} — ${price}${p.description ? ` (${p.description})` : ''}`
      );
    }
    lines.push('');
  }

  lines.push('## Staff roles');
  lines.push('');
  lines.push('Owner, manager, cashier — each with different permissions.');
  lines.push('');

  if (supportEmail) lines.push(`Support email: ${supportEmail}`);
  if (supportPhone) lines.push(`Support phone: ${supportPhone}`);
  if (website) lines.push(`Website: ${website}`);
  lines.push('');

  lines.push('## How to answer');
  lines.push('');
  lines.push('Structure every response as:');
  lines.push('');
  lines.push('1. **Direct answer** — 1–2 sentences that resolve the question.');
  lines.push(
    '2. **Detail** — 2–4 sentences explaining how the feature works, with concrete steps if applicable.'
  );
  lines.push(
    '3. **Related capabilities** — 1–3 other features that might interest them.'
  );
  lines.push(
    `4. **Next step** — a concrete action they can take: register, email ${supportEmail || 'support'}, or read more on the site.`
  );
  lines.push('');

  lines.push('## Style rules');
  lines.push('');
  lines.push('- Minimum 100 words for any feature or pricing question.');
  lines.push(
    '- Never answer with a single sentence. Even a yes/no gets context.'
  );
  lines.push(
    '- Use concrete examples: "You can scan barcodes with any USB scanner", not "barcode support is available".'
  );
  lines.push(
    '- Only describe features listed as available above. Do not invent features.'
  );
  lines.push(
    '- IMPORTANT: If a feature IS listed as available, answer confidently and describe it in detail. Do not deflect to support for available features.'
  );
  lines.push(
    '- Only suggest contacting support for: pricing negotiations, custom development, enterprise contracts, data migration, or questions about features NOT listed.'
  );
  lines.push(
    "- When asked about offline capability, describe the desktop app in detail: it runs fully offline on the cashier's machine, sales save locally in SQLite, and data syncs to the cloud automatically when the internet returns."
  );
  lines.push(`- Reply in the user's language.`);

  const prompt = lines.join('\n');
  await cacheService.set(PROMPT_CACHE_KEY, prompt, PROMPT_TTL);
  return prompt;
}

async function invalidatePromptCache() {
  await cacheService.del(PROMPT_CACHE_KEY);
}

async function checkRateLimit(ip) {
  const redis = getRedis();
  if (!redis) return true;
  const key = `chat:public:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SEC);
  return count <= RATE_LIMIT_PER_IP;
}

async function reply({ text, ip }) {
  if (!text || !text.trim()) {
    return { reply: 'Please type a question.', tokensUsed: 0 };
  }

  const enabled = await isLandingAiEnabled();
  if (!enabled) {
    return { reply: 'The assistant is currently unavailable.', tokensUsed: 0 };
  }

  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return { reply: 'Too many messages. Please try again later.', tokensUsed: 0 };
  }

  try {
    const systemPrompt = await buildSystemPrompt();
    const { reply: answer, tokensUsed } = await chat(text, systemPrompt, {
      type: 'public_chat',
      maxTokens: 2000,
      temperature: 0.6,
    });
    return { reply: answer, tokensUsed };
  } catch (err) {
    logger.error({ err: err.message, ip }, 'publicChat failed');
    const fallback = await PlatformSetting.getValue(
      'support_email',
      'support@smartpos.co.ke'
    );
    return {
      reply: `Sorry, I'm having trouble right now. Email ${fallback}`,
      tokensUsed: 0,
    };
  }
}

module.exports = { reply, buildSystemPrompt, invalidatePromptCache };