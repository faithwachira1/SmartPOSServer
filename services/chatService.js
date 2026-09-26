const PlatformSetting = require('../models/admin/PlatformSetting');
const AiConversation = require('../models/client/AiConversation');
const { chat } = require('./aiService');
const { buildContext, formatContextForPrompt } = require('./chatContextService');
const { getRedis } = require('../config/redis');
const { logger } = require('../utils/logger');

const PROMPT_CACHE_KEY_PREFIX = 'chat:client:system_prompt:';
const PROMPT_TTL = 300;

async function isClientAiEnabled() {
  const doc = await PlatformSetting.findOne({ key: 'ai_config' }).lean();
  const stored = doc?.value && typeof doc.value === 'object' ? doc.value : {};
  return stored.features?.clientAi === true;
}

async function buildBasePrompt() {
  const [platformName, supportEmail] = await Promise.all([
    PlatformSetting.getValue('platform_name', 'SmartPOS'),
    PlatformSetting.getValue('support_email', null),
  ]);

  return [
    `You are the AI business assistant inside ${platformName}, a point-of-sale system used by small business owners and their staff.`,
    '',
    '## Your role',
    '',
    `You help the business owner understand their live data and how to use ${platformName} effectively. You have access to real-time numbers about sales, products, customers, staff, and stock.`,
    '',
    '## How to answer',
    '',
    'Always structure responses like this:',
    '',
    '1. **Direct answer** — 1–2 sentences that resolve the question immediately.',
    '2. **The data behind it** — reference the specific numbers from the LIVE DATA section below. Name the products, customers, amounts, and dates.',
    '3. **What it means** — one short paragraph interpreting the numbers. Is this good? Is it a trend? Should they act on it?',
    '4. **Suggested next steps** — 2–3 concrete actions the owner could take based on the data. Be specific.',
    '',
    '## Style rules',
    '',
    '- Minimum 120 words for any question that involves data. Short yes/no questions can be shorter.',
    '- Never answer with a single sentence unless the question is truly binary.',
    '- Reference actual numbers from the LIVE DATA — do not generalize.',
    '- When comparing periods (today vs week vs month), show the actual figures side by side.',
    '- When a question is vague, state your assumption in one line, then answer.',
    `- If the data does not cover the question, say so plainly and suggest ${supportEmail ? 'emailing ' + supportEmail : 'contacting support'}.`,
    '- Never invent numbers, product names, or customer names.',
    `- Keep replies in the user's language.`,
    supportEmail ? `- Support contact: ${supportEmail}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function buildSystemPrompt(tenantId) {
  const cacheKey = `${PROMPT_CACHE_KEY_PREFIX}${tenantId}`;

  let cached = null;
  try {
    const redis = getRedis();
    if (redis) {
      const raw = await redis.get(cacheKey);
      if (raw) cached = raw;
    }
  } catch {
    // ignore cache errors
  }

  if (cached) return cached;

  const base = await buildBasePrompt();
  const ctx = await buildContext(tenantId).catch(() => null);
  const ctxText = formatContextForPrompt(ctx);

  const prompt = [base, '', ctxText].join('\n');

  try {
    const redis = getRedis();
    if (redis) await redis.set(cacheKey, prompt, 'EX', PROMPT_TTL);
  } catch {
    // ignore
  }

  return prompt;
}

async function reply({ tenantId, userId, text }) {
  if (!text || !text.trim()) {
    return { reply: 'Please type a question.', tokensUsed: 0 };
  }

  const enabled = await isClientAiEnabled();
  if (!enabled) {
    return { reply: 'The AI assistant is currently unavailable.', tokensUsed: 0 };
  }

  try {
    const systemPrompt = await buildSystemPrompt(tenantId);

    let conv = await AiConversation.findOne({ tenantId, userId });
    if (!conv) {
      conv = await AiConversation.create({ tenantId, userId, messages: [] });
    }

    const recent = (conv.messages || []).slice(-10);
    const historyText = recent.length
      ? recent
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n')
      : '';

    const combinedMessage = historyText
      ? `${historyText}\nUser: ${text.trim()}`
      : text.trim();

    const { reply: answer, tokensUsed } = await chat(
      combinedMessage,
      systemPrompt,
      {
        type: 'client_chat',
        tenantId,
        maxTokens: 2000,
        temperature: 0.6,
      }
    );

    conv.messages.push(
      { role: 'user', content: text.trim(), ts: new Date() },
      { role: 'assistant', content: answer, ts: new Date() }
    );

    if (conv.messages.length > 100) {
      conv.messages = conv.messages.slice(-100);
    }

    await conv.save();

    return { reply: answer, tokensUsed };
  } catch (err) {
    logger.error(
      { err: err.message, tenantId, userId },
      'chatService.reply failed'
    );
    return {
      reply: 'Sorry, I could not process that right now. Please try again.',
      tokensUsed: 0,
    };
  }
}

async function history(tenantId, userId, { limit = 50 } = {}) {
  const conv = await AiConversation.findOne({ tenantId, userId }).lean();
  if (!conv) return [];
  return (conv.messages || []).slice(-limit);
}

async function clear(tenantId, userId) {
  await AiConversation.findOneAndUpdate(
    { tenantId, userId },
    { $set: { messages: [] } },
    { upsert: true }
  );
}

module.exports = { reply, history, clear };