const Category = require('../../models/client/Category');
const Product = require('../../models/client/Product');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');

const list = asyncHandler(async (req, res) => {
  const items = await Category.find({
    tenantId: req.tenantId,
    deleted: { $ne: true },
  })
    .sort({ position: 1, name: 1 })
    .lean();

  const counts = await Product.aggregate([
    { $match: { tenantId: req.tenantId, active: true, deleted: { $ne: true } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  const enriched = items.map((c) => ({
    id: c._id.toString(),
    name: c.name,
    position: c.position ?? 0,
    productCount: countMap.get(c.name) || 0,
    createdAt: c.createdAt,
  }));

  return ok(res, enriched);
});

const getOne = asyncHandler(async (req, res) => {
  const category = await Category.findOne({
    _id: req.params.id,
    tenantId: req.tenantId,
    deleted: { $ne: true },
  }).lean();
  if (!category) throw ApiError.notFound('CATEGORY_NOT_FOUND', 'Category not found');
  return ok(res, {
    id: category._id.toString(),
    name: category.name,
    position: category.position ?? 0,
  });
});

const create = asyncHandler(async (req, res) => {
  const { name, position } = req.body;
  if (!name || !String(name).trim()) {
    throw ApiError.badRequest('NAME_REQUIRED', 'Name required');
  }

  const trimmed = String(name).trim();

  const existing = await Category.findOne({
    tenantId: req.tenantId,
    name: trimmed,
    deleted: { $ne: true },
  });
  if (existing) throw ApiError.conflict('CATEGORY_EXISTS', 'Category already exists');

  const count = await Category.countDocuments({
    tenantId: req.tenantId,
    deleted: { $ne: true },
  });

  const category = await Category.create({
    tenantId: req.tenantId,
    name: trimmed,
    position: position ?? count,
  });

  return created(res, {
    id: category._id.toString(),
    name: category.name,
    position: category.position,
    productCount: 0,
    createdAt: category.createdAt,
  });
});

const update = asyncHandler(async (req, res) => {
  const category = await Category.findOne({
    _id: req.params.id,
    tenantId: req.tenantId,
    deleted: { $ne: true },
  });
  if (!category) throw ApiError.notFound('CATEGORY_NOT_FOUND', 'Category not found');

  const { name, position } = req.body;
  const oldName = category.name;

  if (name && String(name).trim() !== category.name) {
    const trimmed = String(name).trim();
    const dup = await Category.findOne({
      tenantId: req.tenantId,
      name: trimmed,
      deleted: { $ne: true },
      _id: { $ne: category._id },
    });
    if (dup) throw ApiError.conflict('CATEGORY_EXISTS', 'Category name already in use');

    category.name = trimmed;

    await Product.updateMany(
      { tenantId: req.tenantId, category: oldName },
      { $set: { category: trimmed } }
    );
  }

  if (position !== undefined) category.position = Number(position) || 0;

  await category.save();

  return ok(res, {
    id: category._id.toString(),
    name: category.name,
    position: category.position,
  });
});

const remove = asyncHandler(async (req, res) => {
  const category = await Category.findOne({
    _id: req.params.id,
    tenantId: req.tenantId,
    deleted: { $ne: true },
  });
  if (!category) throw ApiError.notFound('CATEGORY_NOT_FOUND', 'Category not found');

  const inUse = await Product.countDocuments({
    tenantId: req.tenantId,
    category: category.name,
    active: true,
    deleted: { $ne: true },
  });
  if (inUse > 0) {
    throw ApiError.badRequest(
      'CATEGORY_IN_USE',
      `${inUse} product(s) still use this category`
    );
  }

  category.deleted = true;
  await category.save();
  return ok(res, { deleted: true });
});

const reorder = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) throw ApiError.badRequest('INVALID_INPUT', 'ids array required');

  await Promise.all(
    ids.map((id, i) =>
      Category.updateOne(
        { _id: id, tenantId: req.tenantId },
        { position: i }
      )
    )
  );

  return ok(res, { reordered: true });
});

module.exports = { list, getOne, create, update, remove, reorder };