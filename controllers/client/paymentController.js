const mongoose = require('mongoose');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');
const { logger } = require('../../utils/logger');
const mpesaService = require('../../services/mpesaService');
const Payment = require('../../models/client/Payment');
const Sale = require('../../models/client/Sale');
const Product = require('../../models/client/Product');

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (/^254\d{9}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^\d{9}$/.test(digits)) return `254${digits}`;
  if (/^\+254\d{9}$/.test(String(input).replace(/\s/g, ''))) {
    return digits;
  }
  return null;
}

const initiateStk = asyncHandler(async (req, res) => {
  const { phone, items, discount = 0, vatAmount = 0, customerName } = req.body || {};

  if (!phone) {
    throw ApiError.badRequest('PHONE_REQUIRED', 'Customer phone number is required');
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw ApiError.badRequest(
      'INVALID_PHONE',
      'Enter a valid Kenyan phone number (07xxxxxxxx or 254xxxxxxxxx)'
    );
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw ApiError.badRequest('NO_ITEMS', 'Cart is empty');
  }

  const tenantId = new mongoose.Types.ObjectId(req.tenantId);

  const productIds = items
    .map((i) => i.productId)
    .filter(Boolean)
    .map((id) => new mongoose.Types.ObjectId(id));

  const products = await Product.find({
    _id: { $in: productIds },
    tenantId,
  }).lean();

  const byId = new Map(products.map((p) => [String(p._id), p]));

  const lineItems = [];
  for (const it of items) {
    const product = byId.get(String(it.productId));
    if (!product) {
      throw ApiError.badRequest('PRODUCT_NOT_FOUND', `Product not found: ${it.productId}`);
    }
    const qty = Number(it.quantity) || Number(it.qty) || 0;
    if (qty <= 0) {
      throw ApiError.badRequest('INVALID_QTY', `Invalid quantity for ${product.name}`);
    }
    if (product.stock < qty) {
      throw ApiError.badRequest('INSUFFICIENT_STOCK', `${product.name} only has ${product.stock} in stock`);
    }
    const price = Number(it.price) || product.price || 0;
    lineItems.push({
      productId: product._id,
      name: product.name,
      sku: product.sku || null,
      qty,
      price: Math.round(price),
      subtotal: Math.round(price) * qty,
    });
  }

  const subtotal = lineItems.reduce((s, i) => s + i.subtotal, 0);
  const discountAmt = Math.max(0, Math.round(Number(discount) || 0));
  const vatAmt = Math.max(0, Math.round(Number(vatAmount) || 0));
  const total = Math.max(0, subtotal - discountAmt + vatAmt);

  if (total <= 0) {
    throw ApiError.badRequest('ZERO_TOTAL', 'Order total must be greater than zero');
  }

  const tenant = await mongoose.model('Tenant').findById(req.tenantId).lean();
  const currency = tenant?.settings?.currency || 'KES';

  const creds = await mpesaService.resolveCreds(req.tenantId);

  const year = new Date().getFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  const saleNumber = `S-${year}-${rand}`;

  const sale = await Sale.create({
    tenantId,
    saleNumber,
    items: lineItems,
    subtotal,
    discount: discountAmt,
    tax: vatAmt,
    total,
    currency,
    paymentMethod: 'mpesa',
    paymentStatus: 'pending',
    customerName: customerName || 'Walk-in Customer',
    cashierId: req.user.id,
    voided: false,
  });

  let stk;
  try {
    stk = await mpesaService.stkPush(creds, {
      phone: normalized,
      amount: total,
      accountRef: saleNumber,
      description: `Sale ${saleNumber}`,
    });
  } catch (err) {
    await Sale.updateOne(
      { _id: sale._id },
      { $set: { paymentStatus: 'failed', voided: true } }
    );
    throw err;
  }

  const payment = await Payment.create({
    tenantId,
    purpose: 'sale',
    saleId: sale._id,
    method: 'mpesa',
    amount: total,
    currency,
    status: 'pending',
    providerRef: stk.checkoutRequestId,
  });

  logger.info(
    {
      tenantId: String(tenantId),
      saleId: String(sale._id),
      checkoutRequestId: stk.checkoutRequestId,
      amount: total,
    },
    'STK initiated for sale'
  );

  return created(res, {
    saleId: sale._id,
    saleNumber,
    paymentId: payment._id,
    checkoutRequestId: stk.checkoutRequestId,
    message: stk.customerMessage,
    total,
    currency,
  });
});

const checkStkStatus = asyncHandler(async (req, res) => {
  const { checkoutRequestId } = req.params;

  const payment = await Payment.findOne({
    tenantId: req.tenantId,
    providerRef: checkoutRequestId,
  }).lean();

  if (!payment) {
    throw ApiError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
  }

  const sale = payment.saleId
    ? await Sale.findById(payment.saleId).lean()
    : null;

  return ok(res, {
    status: payment.status,
    paymentId: payment._id,
    saleId: payment.saleId || null,
    saleNumber: sale?.saleNumber || null,
    amount: payment.amount,
    currency: payment.currency,
    receipt: payment.status === 'success' ? payment.providerRef : null,
  });
});

const cancelStk = asyncHandler(async (req, res) => {
  const { checkoutRequestId } = req.params;

  const payment = await Payment.findOne({
    tenantId: req.tenantId,
    providerRef: checkoutRequestId,
  });

  if (!payment) {
    throw ApiError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
  }

  if (payment.status === 'success') {
    throw ApiError.badRequest('ALREADY_PAID', 'Payment already succeeded — cannot cancel');
  }

  payment.status = 'failed';
  await payment.save();

  if (payment.saleId) {
    await Sale.updateOne(
      { _id: payment.saleId },
      { $set: { paymentStatus: 'failed', voided: true } }
    );
  }

  return ok(res, { cancelled: true });
});

module.exports = { initiateStk, checkStkStatus, cancelStk };