const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created, paginated, noContent } = require('../../utils/apiResponse');
const { parsePagination } = require('../../utils/pagination');
const { assertObjectId } = require('../../utils/validateObjectId');
const { tenantFilter } = require('../../utils/tenantScope');
const { ApiError } = require('../../utils/apiError');
const Product = require('../../models/client/Product');
const InventoryMovement = require('../../models/client/InventoryMovement');
const cloudinaryService = require('../../services/cloudinaryService');
const planService = require('../../services/planService');

function shapeProduct(p) {
  return {
    id: p._id.toString(),
    name: p.name,
    sku: p.sku || null,
    barcode: p.barcode || null,
    category: p.category || null,
    price: p.price,
    cost: p.cost || 0,
    stock: p.stock,
    lowStockThreshold: p.lowStockThreshold,
    imageUrl: p.imageUrl || null,
    imagePublicId: p.imagePublicId || null,
    active: p.active,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function nextSkuForTenant(tenantId, category) {
  const prefix = category
    ? `${String(category).replace(/\s+/g, '').slice(0, 3).toUpperCase()}-`
    : 'SKU-';

  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const last = await Product.findOne({
    tenantId,
    sku: { $regex: `^${escaped}\\d+$` },
  })
    .sort({ sku: -1 })
    .select('sku')
    .lean();

  if (!last?.sku) return `${prefix}0001`;

  const num = parseInt(last.sku.replace(prefix, ''), 10);
  const next = Number.isFinite(num) ? num + 1 : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = tenantFilter(req);
  filter.deleted = { $ne: true };

  if (req.query.active !== undefined) {
    filter.active = req.query.active === 'true';
  }
  if (req.query.category) {
    filter.category = req.query.category;
  }
  if (req.query.search) {
    const s = String(req.query.search).trim();
    filter.$or = [
      { name: { $regex: s, $options: 'i' } },
      { sku: { $regex: s, $options: 'i' } },
      { barcode: { $regex: s, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  return paginated(res, items.map(shapeProduct), page, limit, total);
});

const get = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'productId');
  const product = await Product.findOne(
    tenantFilter(req, { _id: req.params.id, deleted: { $ne: true } })
  ).lean();
  if (!product) throw ApiError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
  return ok(res, shapeProduct(product));
});

const create = asyncHandler(async (req, res) => {
  const { name, price } = req.body;
  if (!name || price === undefined) {
    throw ApiError.badRequest('MISSING_FIELDS', 'name and price required');
  }

  const numericPrice = Number(price);
  if (Number.isNaN(numericPrice) || numericPrice < 0) {
    throw ApiError.badRequest('INVALID_PRICE', 'Price must be a positive number');
  }

  await planService.checkProductLimit(req.tenantId, Product);

  const category = req.body.category ? String(req.body.category).trim() : undefined;
  const providedSku = req.body.sku ? String(req.body.sku).trim() : '';
  const sku = providedSku || (await nextSkuForTenant(req.tenantId, category));

  const product = await Product.create({
    tenantId: req.tenantId,
    name: String(name).trim(),
    sku,
    barcode: req.body.barcode ? String(req.body.barcode).trim() : undefined,
    category,
    price: numericPrice,
    cost: Number(req.body.cost) || 0,
    stock: Number(req.body.stock) || 0,
    lowStockThreshold:
      req.body.lowStockThreshold !== undefined
        ? Number(req.body.lowStockThreshold)
        : 5,
    imageUrl: req.body.imageUrl,
    imagePublicId: req.body.imagePublicId,
    active: req.body.active !== false,
    createdBy: req.user.id,
  });

  if (product.stock > 0) {
    await InventoryMovement.create({
      tenantId: req.tenantId,
      productId: product._id,
      type: 'in',
      qty: product.stock,
      reason: 'Initial stock',
      refType: 'manual',
      userId: req.user.id,
      balanceAfter: product.stock,
    });
  }

  return created(res, shapeProduct(product.toObject()));
});

const update = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'productId');

  const allowed = [
    'name',
    'sku',
    'barcode',
    'category',
    'price',
    'cost',
    'lowStockThreshold',
    'imageUrl',
    'imagePublicId',
    'active',
  ];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      if (k === 'price' || k === 'cost' || k === 'lowStockThreshold') {
        patch[k] = Number(req.body[k]) || 0;
      } else if (k === 'name' || k === 'sku' || k === 'barcode' || k === 'category') {
        patch[k] = req.body[k] ? String(req.body[k]).trim() : req.body[k];
      } else {
        patch[k] = req.body[k];
      }
    }
  }

  if (Object.keys(patch).length === 0) {
    throw ApiError.badRequest('NO_CHANGES', 'No valid fields to update');
  }

  const product = await Product.findOneAndUpdate(
    tenantFilter(req, { _id: req.params.id, deleted: { $ne: true } }),
    patch,
    { new: true }
  ).lean();

  if (!product) throw ApiError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
  return ok(res, shapeProduct(product));
});

const remove = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'productId');

  const product = await Product.findOneAndUpdate(
    tenantFilter(req, { _id: req.params.id }),
    { $set: { active: false, deleted: true } },
    { new: true }
  ).lean();

  if (!product) throw ApiError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
  return noContent(res);
});

const uploadImage = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('NO_FILE', 'File required');

  const folder = cloudinaryService.buildFolder(req.tenantId, 'products');
  const result = await cloudinaryService.uploadBuffer(req.file.buffer, {
    folder,
    resourceType: 'image',
  });

  return ok(res, { url: result.url, publicId: result.publicId });
});

module.exports = { list, get, create, update, remove, uploadImage };