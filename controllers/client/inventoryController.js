const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, paginated } = require('../../utils/apiResponse');
const { parsePagination } = require('../../utils/pagination');
const { assertObjectId } = require('../../utils/validateObjectId');
const { tenantFilter } = require('../../utils/tenantScope');
const { ApiError } = require('../../utils/apiError');
const Product = require('../../models/client/Product');
const InventoryMovement = require('../../models/client/InventoryMovement');

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = tenantFilter(req, { active: true });

  if (req.query.lowStock === 'true') {
    filter.$expr = { $lte: ['$stock', '$lowStockThreshold'] };
  }

  const [items, total] = await Promise.all([
    Product.find(filter).sort({ stock: 1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  return paginated(res, items, page, limit, total);
});

const adjust = asyncHandler(async (req, res) => {
  const { productId, qty, reason, cost, supplier, note } = req.body;
  if (!productId || qty === undefined) {
    throw ApiError.badRequest('MISSING_FIELDS', 'productId and qty required');
  }

  assertObjectId(productId, 'productId');

  const product = await Product.findOne(tenantFilter(req, { _id: productId }));
  if (!product) throw ApiError.notFound('PRODUCT_NOT_FOUND', 'Product not found');

  const numericQty = Number(qty);
  const newStock = product.stock + numericQty;
  if (newStock < 0) throw ApiError.badRequest('NEGATIVE_STOCK', 'Stock cannot go below zero');

  product.stock = newStock;

  if (numericQty > 0 && cost !== undefined && cost !== null && cost !== '') {
    const numericCost = Number(cost);
    if (!Number.isNaN(numericCost) && numericCost >= 0) {
      product.cost = numericCost;
    }
  }

  await product.save();

  const composedReason = reason
    ? reason
    : supplier || note
      ? ['Restock', supplier, note].filter(Boolean).join(' · ')
      : numericQty > 0
        ? 'Restock'
        : 'Adjustment';

  await InventoryMovement.create({
    tenantId: req.tenantId,
    productId: product._id,
    type: numericQty > 0 ? 'in' : 'adjustment',
    qty: numericQty,
    reason: composedReason,
    refType: 'manual',
    userId: req.user.id,
    balanceAfter: newStock,
  });

  return ok(res, { productId: product._id, stock: newStock, cost: product.cost });
});

const history = asyncHandler(async (req, res) => {
  assertObjectId(req.params.productId, 'productId');
  const { page, limit, skip } = parsePagination(req.query);

  const filter = tenantFilter(req, { productId: req.params.productId });
  const [items, total] = await Promise.all([
    InventoryMovement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    InventoryMovement.countDocuments(filter),
  ]);

  return paginated(res, items, page, limit, total);
});

const movements = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = tenantFilter(req);

  if (req.query.type) filter.type = req.query.type;
  if (req.query.productId) filter.productId = req.query.productId;
  if (req.query.refType) filter.refType = req.query.refType;

  const [items, total] = await Promise.all([
    InventoryMovement.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('productId', 'name sku')
      .populate('userId', 'fullName')
      .lean(),
    InventoryMovement.countDocuments(filter),
  ]);

  const shaped = items.map((m) => ({
    id: m._id.toString(),
    productId: m.productId?._id?.toString() || null,
    productName: m.productId?.name || 'Unknown product',
    productSku: m.productId?.sku || null,
    type: m.type,
    qty: m.qty,
    reason: m.reason || null,
    refType: m.refType || null,
    refId: m.refId ? m.refId.toString() : null,
    userId: m.userId?._id?.toString() || null,
    userName: m.userId?.fullName || null,
    balanceAfter: m.balanceAfter ?? null,
    createdAt: m.createdAt,
  }));

  return paginated(res, shaped, page, limit, total);
});

module.exports = { list, adjust, history, movements };