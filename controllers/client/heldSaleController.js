const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/apiResponse');
const { assertObjectId } = require('../../utils/validateObjectId');
const { tenantFilter } = require('../../utils/tenantScope');
const { ApiError } = require('../../utils/apiError');
const HeldSale = require('../../models/client/HeldSale');
const Product = require('../../models/client/Product');

const HOLD_TTL_HOURS = 24;
const whole = (n) => Math.round(Number(n) || 0);

function shapeHeld(h) {
  return {
    id: h._id.toString(),
    cashierId: h.cashierId?.toString() || null,
    cashierName: h.cashierName || null,
    items: (h.items || []).map((i) => ({
      productId: i.productId?.toString() || null,
      name: i.name,
      sku: i.sku || null,
      qty: i.qty,
      price: i.price,
      subtotal: i.subtotal,
    })),
    subtotal: h.subtotal,
    discount: h.discount,
    vatAmount: h.vatAmount,
    total: h.total,
    currency: h.currency,
    customerId: h.customerId?.toString() || null,
    customerName: h.customerName || null,
    loyaltyCardNumber: h.loyaltyCardNumber || null,
    label: h.label || null,
    note: h.note || null,
    expiresAt: h.expiresAt,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

const list = asyncHandler(async (req, res) => {
  const filter = tenantFilter(req);
  filter.expiresAt = { $gt: new Date() };
  filter.deleted = { $ne: true };

  const items = await HeldSale.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return ok(res, items.map(shapeHeld));
});

const get = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'heldSaleId');
  const held = await HeldSale.findOne(
    tenantFilter(req, { _id: req.params.id, deleted: { $ne: true } })
  ).lean();
  if (!held) throw ApiError.notFound('HELD_SALE_NOT_FOUND', 'Held sale not found');
  if (held.expiresAt <= new Date()) {
    throw ApiError.notFound('HELD_SALE_EXPIRED', 'Held sale has expired');
  }
  return ok(res, shapeHeld(held));
});

const create = asyncHandler(async (req, res) => {
  const {
    items,
    customerId,
    customerName,
    loyaltyCardNumber,
    label,
    note,
  } = req.body;

  if (!Array.isArray(items) || !items.length) {
    throw ApiError.badRequest('NO_ITEMS', 'Held sale must have items');
  }

  let subtotal = 0;
  const heldItems = [];

  for (const item of items) {
    const productId = item.productId || item._id;
    if (!productId) continue;

    const product = await Product.findOne(
      tenantFilter(req, { _id: productId, deleted: { $ne: true } })
    ).lean();
    if (!product) continue;

    const qty = Number(item.quantity ?? item.qty) || 0;
    if (qty <= 0) continue;

    const unitPrice = whole(item.price ?? product.price);
    const lineTotal = whole(unitPrice * qty);
    subtotal += lineTotal;

    heldItems.push({
      productId: product._id,
      name: product.name,
      sku: product.sku,
      qty,
      price: unitPrice,
      subtotal: lineTotal,
    });
  }

  if (!heldItems.length) {
    throw ApiError.badRequest('NO_VALID_ITEMS', 'No valid items to hold');
  }

  subtotal = whole(subtotal);
  const discount = whole(req.body.discount);
  const vatAmount = whole(req.body.vatAmount);
  const total = Math.max(0, whole(subtotal - discount + vatAmount));
  const currency = req.body.currency || 'KES';

  const expiresAt = new Date(Date.now() + HOLD_TTL_HOURS * 60 * 60 * 1000);

  const held = await HeldSale.create({
    tenantId: req.tenantId,
    cashierId: req.user.id,
    cashierName: req.user.fullName || null,
    items: heldItems,
    subtotal,
    discount,
    vatAmount,
    total,
    currency,
    customerId: customerId || null,
    customerName: customerName || null,
    loyaltyCardNumber: loyaltyCardNumber || null,
    label: label ? String(label).trim() : null,
    note: note ? String(note).trim() : null,
    expiresAt,
  });

  return created(res, shapeHeld(held.toObject()));
});

const remove = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'heldSaleId');
  const held = await HeldSale.findOneAndUpdate(
    tenantFilter(req, { _id: req.params.id, deleted: { $ne: true } }),
    { $set: { deleted: true } },
    { new: true }
  ).lean();
  if (!held) throw ApiError.notFound('HELD_SALE_NOT_FOUND', 'Held sale not found');
  return ok(res, { deleted: true, id: held._id.toString() });
});

module.exports = { list, get, create, remove };