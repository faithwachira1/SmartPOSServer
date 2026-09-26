const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created, paginated } = require('../../utils/apiResponse');
const { parsePagination } = require('../../utils/pagination');
const { assertObjectId } = require('../../utils/validateObjectId');
const { tenantFilter } = require('../../utils/tenantScope');
const { ApiError } = require('../../utils/apiError');
const Customer = require('../../models/client/Customer');
const Sale = require('../../models/client/Sale');

function shapeCustomer(c) {
  return {
    id: c._id.toString(),
    name: c.name,
    phone: c.phone || null,
    email: c.email || null,
    address: c.address || null,
    notes: c.notes || null,
    loyaltyCardNumber: c.loyaltyCardNumber || null,
    totalSpent: c.totalSpent || 0,
    loyaltyPoints: c.loyaltyPoints || 0,
    visitCount: c.visitCount || 0,
    lastPurchaseAt: c.lastPurchaseAt || null,
    active: c.active,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function normalizePhone(input) {
  if (!input) return '';
  const digits = String(input).replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('0') && digits.length === 10) {
    return `254${digits.slice(1)}`;
  }
  if (digits.startsWith('254') && digits.length === 12) {
    return digits;
  }
  if (digits.length >= 9 && digits.length <= 15) {
    return digits;
  }
  return digits;
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = tenantFilter(req);
  filter.deleted = { $ne: true };

  if (req.query.search) {
    const s = String(req.query.search).trim();
    filter.$or = [
      { name: { $regex: s, $options: 'i' } },
      { phone: { $regex: s, $options: 'i' } },
      { email: { $regex: s, $options: 'i' } },
      { loyaltyCardNumber: { $regex: s, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Customer.countDocuments(filter),
  ]);

  return paginated(res, items.map(shapeCustomer), page, limit, total);
});

const get = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'customerId');
  const customer = await Customer.findOne(
    tenantFilter(req, { _id: req.params.id, deleted: { $ne: true } })
  ).lean();
  if (!customer) throw ApiError.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
  return ok(res, shapeCustomer(customer));
});

const create = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) {
    throw ApiError.badRequest('NAME_REQUIRED', 'Name required');
  }

  const phone = normalizePhone(req.body.phone);

  if (phone) {
    const existing = await Customer.findOne({
      tenantId: req.tenantId,
      phone,
      active: true,
      deleted: { $ne: true },
    }).lean();

    if (existing) {
      throw ApiError.conflict(
        'PHONE_TAKEN',
        `Phone already used by customer "${existing.name}"`
      );
    }
  }

  const cardNumber = req.body.loyaltyCardNumber
    ? String(req.body.loyaltyCardNumber).trim()
    : phone || undefined;

  const customer = await Customer.create({
    tenantId: req.tenantId,
    name: String(name).trim(),
    phone: phone || undefined,
    email: req.body.email ? String(req.body.email).trim().toLowerCase() : undefined,
    address: req.body.address ? String(req.body.address).trim() : undefined,
    notes: req.body.notes ? String(req.body.notes).trim() : undefined,
    loyaltyCardNumber: cardNumber,
  });

  return created(res, shapeCustomer(customer.toObject()));
});

const update = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'customerId');

  const allowed = ['name', 'phone', 'email', 'address', 'notes', 'loyaltyCardNumber', 'active'];
  const patch = {};

  for (const k of allowed) {
    if (req.body[k] === undefined) continue;

    if (k === 'email') {
      patch.email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
    } else if (k === 'phone') {
      patch.phone = normalizePhone(req.body.phone) || null;
    } else if (k === 'address' || k === 'notes' || k === 'loyaltyCardNumber') {
      patch[k] = req.body[k] ? String(req.body[k]).trim() : null;
    } else if (k === 'name') {
      patch.name = String(req.body.name).trim();
    } else {
      patch[k] = req.body[k];
    }
  }

  if (Object.keys(patch).length === 0) {
    throw ApiError.badRequest('NO_CHANGES', 'No valid fields');
  }

  if (patch.phone) {
    const existing = await Customer.findOne({
      tenantId: req.tenantId,
      phone: patch.phone,
      active: true,
      deleted: { $ne: true },
      _id: { $ne: req.params.id },
    }).lean();

    if (existing) {
      throw ApiError.conflict(
        'PHONE_TAKEN',
        `Phone already used by customer "${existing.name}"`
      );
    }
  }

  if (patch.phone && patch.loyaltyCardNumber === undefined) {
    const current = await Customer.findOne(
      tenantFilter(req, { _id: req.params.id })
    )
      .select('phone loyaltyCardNumber')
      .lean();

    if (
      current &&
      (!current.loyaltyCardNumber || current.loyaltyCardNumber === current.phone)
    ) {
      patch.loyaltyCardNumber = patch.phone;
    }
  }

  const customer = await Customer.findOneAndUpdate(
    tenantFilter(req, { _id: req.params.id, deleted: { $ne: true } }),
    patch,
    { new: true }
  ).lean();

  if (!customer) throw ApiError.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
  return ok(res, shapeCustomer(customer));
});

const remove = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'customerId');

  const customer = await Customer.findOne(
    tenantFilter(req, { _id: req.params.id, deleted: { $ne: true } })
  );
  if (!customer) throw ApiError.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');

  const salesCount = await Sale.countDocuments({
    tenantId: req.tenantId,
    customerId: customer._id,
    voided: { $ne: true },
  });

  if (salesCount > 0) {
    throw ApiError.badRequest(
      'CUSTOMER_HAS_SALES',
      `Cannot delete — this customer has ${salesCount} sale${salesCount === 1 ? '' : 's'}. Deactivate them instead.`
    );
  }

  customer.deleted = true;
  customer.active = false;
  await customer.save();

  return ok(res, { deleted: true, id: customer._id.toString() });
});

module.exports = { list, get, create, update, remove };