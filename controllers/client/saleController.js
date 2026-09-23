const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created, paginated } = require('../../utils/apiResponse');
const { parsePagination } = require('../../utils/pagination');
const { assertObjectId } = require('../../utils/validateObjectId');
const { tenantFilter } = require('../../utils/tenantScope');
const { resolveDateRange } = require('../../utils/dateRange');
const { ApiError } = require('../../utils/apiError');
const Sale = require('../../models/client/Sale');
const Product = require('../../models/client/Product');
const Customer = require('../../models/client/Customer');
const Tenant = require('../../models/admin/Tenant');
const HeldSale = require('../../models/client/HeldSale');
const InventoryMovement = require('../../models/client/InventoryMovement');
const planService = require('../../services/planService');

function generateSaleNumber() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `S-${stamp}-${rand}`;
}

const whole = (n) => Math.round(Number(n) || 0);

function normalizeCardNumber(input) {
  if (!input) return '';
  const digits = String(input).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 10) {
    return `254${digits.slice(1)}`;
  }
  return digits;
}

function shapeSale(s) {
  return {
    id: s._id.toString(),
    saleNumber: s.saleNumber,
    items: (s.items || []).map((i) => ({
      productId: i.productId?.toString() || null,
      name: i.name,
      sku: i.sku || null,
      qty: i.qty,
      price: i.price,
      subtotal: i.subtotal,
    })),
    subtotal: s.subtotal,
    discount: s.discount,
    tax: s.tax,
    vatRate: s.vatRate || 0,
    vatAmount: s.vatAmount || 0,
    total: s.total,
    currency: s.currency,
    paymentMethod: s.paymentMethod || null,
    paymentStatus: s.paymentStatus,
    amountPaid: s.amountPaid || 0,
    changeAmount: s.changeAmount || 0,
    cashierId: s.cashierId?.toString() || null,
    customerId: s.customerId?.toString() || null,
    customerName: s.customerName || null,
    loyaltyCardNumber: s.loyaltyCardNumber || null,
    voided: s.voided,
    voidReason: s.voidReason || null,
    voidedBy: s.voidedBy?.toString() || null,
    voidedAt: s.voidedAt || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

const create = asyncHandler(async (req, res) => {
  const {
    items,
    paymentMethod,
    customerId,
    discount: inputDiscount,
    amountPaid: inputAmountPaid,
    changeAmount: inputChangeAmount,
    customerName,
    loyaltyCardNumber,
    vatRate: inputVatRate,
    vatAmount: inputVatAmount,
    heldSaleId,
  } = req.body;

  if (!Array.isArray(items) || !items.length) {
    throw ApiError.badRequest('NO_ITEMS', 'Sale must have items');
  }

  await planService.checkTransactionLimit(req.tenantId, Sale);

  const tenant = await Tenant.findById(req.tenantId).lean();
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const settings = tenant.settings || {};
  const currency = settings.currency || 'KES';

  const productIds = items.map((i) => i.productId);
  const products = await Product.find(
    tenantFilter(req, { _id: { $in: productIds } })
  ).lean();
  const productsById = Object.fromEntries(products.map((p) => [p._id.toString(), p]));

  let subtotal = 0;
  const saleItems = [];

  for (const item of items) {
    const product = productsById[String(item.productId)];
    if (!product) {
      throw ApiError.badRequest('PRODUCT_NOT_FOUND', `Product ${item.productId} not found`);
    }
    const qty = Number(item.quantity ?? item.qty);
    if (!qty || qty <= 0) {
      throw ApiError.badRequest('INVALID_QTY', `Invalid quantity for ${product.name}`);
    }
    if (product.stock < qty) {
      throw ApiError.badRequest('INSUFFICIENT_STOCK', `Not enough stock for ${product.name}`);
    }

    const unitPrice = item.price !== undefined ? whole(item.price) : whole(product.price);
    const lineTotal = whole(unitPrice * qty);
    subtotal += lineTotal;

    saleItems.push({
      productId: product._id,
      name: product.name,
      sku: product.sku,
      qty,
      price: unitPrice,
      subtotal: lineTotal,
    });
  }

  subtotal = whole(subtotal);

  let discount = whole(inputDiscount);
  discount = Math.min(discount, subtotal);

  const vatRate = Number(inputVatRate) || 0;
  const vatAmount = whole(inputVatAmount);

  const total = Math.max(0, whole(subtotal - discount + vatAmount));

  const amountPaid =
    inputAmountPaid !== undefined ? whole(inputAmountPaid) : total;
  const changeAmount =
    inputChangeAmount !== undefined
      ? whole(inputChangeAmount)
      : Math.max(0, whole(amountPaid - total));

  let resolvedCustomerId = customerId || null;
  const normalizedCard = normalizeCardNumber(loyaltyCardNumber);

  if (!resolvedCustomerId && normalizedCard) {
    const match = await Customer.findOne({
      tenantId: req.tenantId,
      loyaltyCardNumber: normalizedCard,
      active: true,
    }).lean();

    if (match) resolvedCustomerId = match._id;
  }

  const sale = await Sale.create({
    tenantId: req.tenantId,
    saleNumber: generateSaleNumber(),
    items: saleItems,
    subtotal,
    discount,
    tax: vatAmount,
    vatRate,
    vatAmount,
    total,
    currency,
    paymentMethod,
    paymentStatus: 'paid',
    amountPaid,
    changeAmount,
    cashierId: req.user.id,
    customerId: resolvedCustomerId || null,
    customerName: customerName || null,
    loyaltyCardNumber: normalizedCard || null,
  });

  for (const item of saleItems) {
    const product = productsById[String(item.productId)];
    const newStock = product.stock - item.qty;

    await Product.updateOne({ _id: product._id }, { $set: { stock: newStock } });

    await InventoryMovement.create({
      tenantId: req.tenantId,
      productId: product._id,
      type: 'sale',
      qty: -item.qty,
      refType: 'sale',
      refId: sale._id,
      userId: req.user.id,
      balanceAfter: newStock,
    });
  }

  if (resolvedCustomerId) {
    const incUpdate = {
      totalSpent: total,
      visitCount: 1,
    };

    if (settings.loyaltyEnabled === true) {
      const pointsPerAmount = Number(settings.loyaltyPointsPerAmount) || 100;
      const earned = pointsPerAmount > 0 ? Math.floor(total / pointsPerAmount) : 0;
      if (earned > 0) incUpdate.loyaltyPoints = earned;
    }

    await Customer.updateOne(
      tenantFilter(req, { _id: resolvedCustomerId }),
      {
        $inc: incUpdate,
        $set: { lastPurchaseAt: new Date() },
      }
    );
  }

  if (heldSaleId) {
    HeldSale.findOneAndDelete({
      _id: heldSaleId,
      tenantId: req.tenantId,
    }).catch(() => {});
  }

  return created(res, shapeSale(sale.toObject()));
});

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = tenantFilter(req);

  const { start, end } = resolveDateRange(req.query);
  filter.createdAt = { $gte: start, $lte: end };

  if (req.query.voided !== undefined) {
    filter.voided = req.query.voided === 'true';
  }
  if (req.user.role === 'cashier') filter.cashierId = req.user.id;
  if (req.query.cashierId && req.user.role !== 'cashier') {
    filter.cashierId = req.query.cashierId;
  }
  if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
  if (req.query.customerId) filter.customerId = req.query.customerId;
  if (req.query.search) {
    const s = String(req.query.search).trim();
    filter.$or = [
      { saleNumber: { $regex: s, $options: 'i' } },
      { customerName: { $regex: s, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    Sale.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Sale.countDocuments(filter),
  ]);

  return paginated(res, items.map(shapeSale), page, limit, total);
});

const get = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'saleId');

  const filter = tenantFilter(req, { _id: req.params.id });
  if (req.user.role === 'cashier') filter.cashierId = req.user.id;

  const sale = await Sale.findOne(filter).lean();
  if (!sale) throw ApiError.notFound('SALE_NOT_FOUND', 'Sale not found');
  return ok(res, shapeSale(sale));
});

const voidSale = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'saleId');

  if (req.user.role === 'cashier') {
    throw ApiError.forbidden('NOT_ALLOWED', 'Only owners and managers can void sales');
  }

  const sale = await Sale.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!sale) throw ApiError.notFound('SALE_NOT_FOUND', 'Sale not found');
  if (sale.voided) throw ApiError.badRequest('ALREADY_VOIDED', 'Sale already voided');

  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    throw ApiError.badRequest('REASON_REQUIRED', 'Void reason is required');
  }

  sale.voided = true;
  sale.voidReason = reason;
  sale.voidedBy = req.user.id;
  sale.voidedAt = new Date();
  await sale.save();

  for (const item of sale.items) {
    const product = await Product.findById(item.productId);
    if (!product) continue;

    const newStock = product.stock + item.qty;
    await Product.updateOne({ _id: product._id }, { $set: { stock: newStock } });

    await InventoryMovement.create({
      tenantId: req.tenantId,
      productId: product._id,
      type: 'sale_return',
      qty: item.qty,
      reason: `Sale voided: ${reason}`,
      refType: 'sale',
      refId: sale._id,
      userId: req.user.id,
      balanceAfter: newStock,
    });
  }

  // Reverse customer stats if there was a customer
  if (sale.customerId) {
    const decUpdate = {
      totalSpent: -sale.total,
      visitCount: -1,
    };

    const tenant = await Tenant.findById(req.tenantId).lean();
    const settings = tenant?.settings || {};

    if (settings.loyaltyEnabled === true) {
      const pointsPerAmount = Number(settings.loyaltyPointsPerAmount) || 100;
      const earned = pointsPerAmount > 0 ? Math.floor(sale.total / pointsPerAmount) : 0;
      if (earned > 0) decUpdate.loyaltyPoints = -earned;
    }

    await Customer.updateOne(
      tenantFilter(req, { _id: sale.customerId }),
      { $inc: decUpdate }
    );
  }

  return ok(res, shapeSale(sale.toObject()));
});

const reprint = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'saleId');
  const sale = await Sale.findOne(tenantFilter(req, { _id: req.params.id })).lean();
  if (!sale) throw ApiError.notFound('SALE_NOT_FOUND', 'Sale not found');
  return ok(res, shapeSale(sale));
});

module.exports = { create, list, get, voidSale, reprint };