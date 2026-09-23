const axios = require('axios');
const { env } = require('../config/env');
const crypto = require('../utils/crypto');
const cacheService = require('./cacheService');
const { ApiError } = require('../utils/apiError');
const { logger } = require('../utils/logger');
const Tenant = require('../models/admin/Tenant');

const BASE_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

const ENDPOINTS = {
  OAUTH: '/oauth/v1/generate?grant_type=client_credentials',
  STK_PUSH: '/mpesa/stkpush/v1/processrequest',
  STK_QUERY: '/mpesa/stkpushquery/v1/query',
};

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function password(shortcode, passkey, ts) {
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
}

function baseUrlFor(envName) {
  return BASE_URLS[envName] || BASE_URLS.sandbox;
}

async function getAccessToken(creds) {
  if (!creds?.consumerKey || !creds?.consumerSecret) {
    throw ApiError.badRequest(
      'MPESA_CREDS_MISSING',
      'M-Pesa credentials are not configured'
    );
  }

  const envName = creds.env || 'sandbox';
  const cacheKey = `mpesa:token:${creds.tenantId || 'platform'}:${envName}:${creds.consumerKey.slice(0, 8)}`;

  const cached = await cacheService.get(cacheKey);
  if (cached) return cached;

  const auth = Buffer.from(
    `${creds.consumerKey}:${creds.consumerSecret}`
  ).toString('base64');

  try {
    const res = await axios.get(`${baseUrlFor(envName)}${ENDPOINTS.OAUTH}`, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 15000,
    });
    const token = res.data.access_token;
    if (!token) {
      throw new Error('No access token in response');
    }
    await cacheService.set(cacheKey, token, 3000);
    return token;
  } catch (err) {
    logger.error({ err: err.message, env: envName }, 'mpesa token failed');
    throw ApiError.internal('MPESA_AUTH', 'M-Pesa authentication failed');
  }
}

async function stkPush(creds, { phone, amount, accountRef, description }) {
  const token = await getAccessToken(creds);
  const envName = creds.env || 'sandbox';
  const ts = timestamp();
  const pwd = password(creds.shortcode, creds.passkey, ts);
  const callbackUrl = creds.callbackUrl || env.mpesa.callbackUrl;

  if (!callbackUrl) {
    throw ApiError.internal(
      'MPESA_NO_CALLBACK',
      'M-Pesa callback URL is not configured'
    );
  }

  try {
    const res = await axios.post(
      `${baseUrlFor(envName)}${ENDPOINTS.STK_PUSH}`,
      {
        BusinessShortCode: creds.shortcode,
        Password: pwd,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: phone,
        PartyB: creds.shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: accountRef,
        TransactionDesc: description,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      }
    );

    return {
      success: true,
      checkoutRequestId: res.data.CheckoutRequestID,
      merchantRequestId: res.data.MerchantRequestID,
      customerMessage: res.data.CustomerMessage,
      raw: res.data,
    };
  } catch (err) {
    const detail =
      err.response?.data?.errorMessage ||
      err.response?.data?.errorCode ||
      err.message;
    logger.error(
      { err: detail, env: envName, shortcode: creds.shortcode },
      'mpesa stk push failed'
    );
    throw ApiError.badRequest(
      'MPESA_STK_FAILED',
      detail || 'Could not initiate M-Pesa payment'
    );
  }
}

async function queryStkStatus(creds, checkoutRequestId) {
  const token = await getAccessToken(creds);
  const envName = creds.env || 'sandbox';
  const ts = timestamp();
  const pwd = password(creds.shortcode, creds.passkey, ts);

  try {
    const res = await axios.post(
      `${baseUrlFor(envName)}${ENDPOINTS.STK_QUERY}`,
      {
        BusinessShortCode: creds.shortcode,
        Password: pwd,
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      }
    );
    return { success: true, raw: res.data };
  } catch (err) {
    const detail = err.response?.data?.errorMessage || err.message;
    logger.error({ err: detail }, 'mpesa query failed');
    return { success: false, error: detail };
  }
}

async function resolveCreds(tenantId) {
  // IMPORTANT: no fallback to platform env creds.
  // If the tenant hasn't configured their own M-Pesa, STK must fail.
  // The only env value used here is the callback URL, which is a platform
  // concern — Safaricom always calls back to our server, not the tenant's.
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) {
    throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');
  }

  const s = tenant.settings || {};
  if (s.mpesaStkEnabled !== true) {
    throw ApiError.badRequest(
      'MPESA_NOT_CONFIGURED',
      'M-Pesa STK checkout is not enabled for this business'
    );
  }

  const m = s.mpesa || {};
  if (
    !m.shortcode ||
    !m.consumerKeyEnc ||
    !m.consumerSecretEnc ||
    !m.passkeyEnc
  ) {
    throw ApiError.badRequest(
      'MPESA_CREDS_MISSING',
      'M-Pesa credentials are incomplete — please finish setup in Settings → Payments'
    );
  }

  return {
    tenantId: String(tenant._id),
    env: m.env || 'sandbox',
    shortcode: m.shortcode,
    consumerKey: crypto.decrypt(m.consumerKeyEnc),
    consumerSecret: crypto.decrypt(m.consumerSecretEnc),
    passkey: crypto.decrypt(m.passkeyEnc),
    callbackUrl: env.mpesa.callbackUrl,
  };
}

function parseCallback(payload) {
  const stk = payload?.Body?.stkCallback;
  if (!stk) return { success: false, error: 'Invalid callback shape' };

  const resultCode = stk.ResultCode;
  const items = stk.CallbackMetadata?.Item || [];
  const pick = (name) => items.find((i) => i.Name === name)?.Value;

  return {
    success: resultCode === 0,
    resultCode,
    resultDesc: stk.ResultDesc,
    checkoutRequestId: stk.CheckoutRequestID,
    merchantRequestId: stk.MerchantRequestID,
    amount: pick('Amount'),
    mpesaReceiptNumber: pick('MpesaReceiptNumber'),
    transactionDate: pick('TransactionDate'),
    phone: pick('PhoneNumber'),
  };
}

module.exports = {
  getAccessToken,
  stkPush,
  queryStkStatus,
  resolveCreds,
  parseCallback,
};