const crypto = require('crypto');
const mongoose = require('mongoose');
const Tenant = require('../models/admin/Tenant');
const Product = require('../models/client/Product');
const Category = require('../models/client/Category');
const Customer = require('../models/client/Customer');
const Sale = require('../models/client/Sale');
const User = require('../models/client/User');
const Device = require('./models/Device');
const IdempotencyKey = require('./models/IdempotencyKey');
const { asyncHandler } = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { ApiError } = require('../utils/apiError');
const { logger } = require('../utils/logger');

const SCHEMA_VERSION = 1;
const EPOCH = new Date(0);
const MAX_ITEMS_PER_PUSH = 100;

function parseSince(input) {
  if (!input) return EPOCH;
  const d = new Date(input);
  return isNaN(d.getTime()) ? EPOCH : d;
}

function randomChunk(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function stripInternal(doc) {
  const out = { ...doc };
  delete out.__v;
  delete out.keyHash;
  return out;
}

async function pullCatalog({ tenantId, branchId, since }) {
  const sinceDate = parseSince(since);

  const productQuery = Product.find({ tenantId }).lean();
  const categoryQuery = Category.find({ tenantId }).lean();
  const customerQuery = Customer.find({ tenantId }).lean();
  const staffQuery = User.find({ tenantId }).lean();

  const [allProducts, allCategories, allCustomers, allStaff] = await Promise.all([
    productQuery,
    categoryQuery,
    customerQuery,
    staffQuery,
  ]);

  const filterByUpdatedAt = (rows) =>
    rows.filter((r) => !r.updatedAt || r.updatedAt > sinceDate);

  const filterDeleted = (rows) => rows.filter((r) => !r.deleted);
  const collectTombstones = (rows) =>
    rows
      .filter((r) => r.deleted && r.updatedAt && r.updatedAt > sinceDate)
      .map((r) => String(r._id));

  const products = filterByUpdatedAt(allProducts);
  const categories = filterByUpdatedAt(allCategories);
  const customers = filterByUpdatedAt(allCustomers);
  const staff = filterByUpdatedAt(allStaff);

  const branchStock = allProducts
    .filter((p) => p.active)
    .map((p) => ({
      productId: String(p._id),
      stock: Number(p.stock) || 0,
      updatedAt: p.updatedAt,
    }));

  const tenant = await Tenant.findById(tenantId).lean();
  const settings = tenant?.settings || {};
  const branch = {
    _id: String(branchId),
    name: tenant?.name || 'Main',
    code: 'MAIN',
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    serverTime: new Date().toISOString(),
    products: filterDeleted(products).map(stripInternal),
    categories: filterDeleted(categories).map(stripInternal),
    customers: filterDeleted(customers).map(stripInternal),
    staff: filterDeleted(staff)
      .map(stripInternal)
      .map((u) => ({
        _id: u._id,
        fullName: u.fullName,
        role: u.role,
        active: u.active !== false,
        updatedAt: u.updatedAt,
      })),
    settings,
    branch,
    branchStock,
    tombstones: {
      products: collectTombstones(products),
      categories: collectTombstones(categories),
      customers: collectTombstones(customers),
      staff: collectTombstones(staff),
    },
  };
}

const pull = asyncHandler(async (req, res) => {
  const { since } = req.query;
  const data = await pullCatalog({
    tenantId: req.tenantId,
    branchId: req.branchId,
    since,
  });

  Device.updateOne(
    { _id: req.device._id },
    { $set: { lastSyncAt: new Date() } }
  ).catch(() => {});

  return ok(res, data);
});

async function resolveCustomerRef({ tenantId, payload }) {
  if (!payload.customerLocalId) return null;

  const key = await IdempotencyKey.findOne({
    tenantId,
    localId: payload.customerLocalId,
    type: 'customer',
  }).lean();

  return key?.serverId || null;
}

async function processCustomer({ tenantId, item }) {
  const p = item.payload || {};

  if (!p.name || !String(p.name).trim()) {
    throw ApiError.badRequest('CUSTOMER_NAME_MISSING', 'Customer name is required');
  }

  if (p.phone) {
    const existing = await Customer.findOne({
      tenantId,
      phone: p.phone,
    }).lean();
    if (existing) {
      return { record: existing, deduped: true };
    }
  }

  const doc = await Customer.create({
    tenantId,
    name: String(p.name).trim(),
    phone: p.phone || null,
    email: p.email || null,
    address: p.address || null,
    loyaltyCardNumber: p.loyaltyCardNumber || null,
    totalSpent: 0,
    loyaltyPoints: 0,
    visitCount: 0,
    active: true,
    localId: item.localId,
    deviceId: item.deviceId || null,
  });

  return { record: doc.toObject(), deduped: false };
}

async function processSale({ tenantId, branchId, device, item }) {
  const p = item.payload || {};

  if (!Array.isArray(p.items) || p.items.length === 0) {
    throw ApiError.badRequest('SALE_NO_ITEMS', 'Sale has no items');
  }

  const warnings = [];
  const productIds = p.items
    .map((i) => i.productId)
    .filter(Boolean)
    .map((id) => new mongoose.Types.ObjectId(id));

  const products = await Product.find({
    _id: { $in: productIds },
    tenantId,
  }).lean();

  const byId = new Map(products.map((prod) => [String(prod._id), prod]));

  const items = p.items.map((i) => {
    const product = byId.get(String(i.productId));
    if (!product) {
      warnings.push('PRODUCT_NOT_FOUND');
    }

    const qty = Number(i.qty ?? i.quantity) || 0;
    const price = Math.round(Number(i.price) || 0);
    const subtotal = Math.round(
      Number(i.subtotal) || price * qty || 0
    );

    return {
      productId: i.productId ? new mongoose.Types.ObjectId(i.productId) : null,
      name: i.name || product?.name || 'Unknown',
      sku: i.sku || product?.sku || null,
      qty,
      price,
      subtotal,
    };
  });

  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const discount = Math.max(0, Math.round(Number(p.discount) || 0));
  const tax = Math.max(0, Math.round(Number(p.tax) || 0));
  const total = Math.max(0, subtotal - discount + tax);

  let customerId = null;
  if (p.customerLocalId) {
    customerId = await resolveCustomerRef({ tenantId, payload: p });
  } else if (p.customerId) {
    customerId = p.customerId;
  }

  let saleNumber = String(p.saleNumber || '').trim();
  if (!saleNumber) {
    saleNumber = `S-${new Date().getFullYear()}-${randomChunk(6)}`;
  } else {
    const clash = await Sale.findOne({ tenantId, saleNumber }).lean();
    if (clash) {
      saleNumber = `${saleNumber}-${randomChunk(2)}`;
      warnings.push('SALE_NUMBER_SUFFIXED');
    }
  }

  const createdAt = p.createdAt ? new Date(p.createdAt) : new Date();

  const doc = await Sale.create({
    tenantId,
    branchId,
    saleNumber,
    items,
    subtotal,
    discount,
    tax,
    vatRate: Number(p.vatRate) || 0,
    vatAmount: Number(p.vatAmount) || 0,
    total,
    currency: p.currency || 'KES',
    paymentMethod: p.paymentMethod || 'cash',
    paymentStatus: p.paymentStatus || 'paid',
    amountPaid: Number(p.amountPaid) || total,
    changeAmount: Number(p.changeAmount) || 0,
    cashierId: device.userId || null,
    customerId,
    customerName: p.customerName || 'Walk-in Customer',
    loyaltyCardNumber: p.loyaltyCardNumber || null,
    voided: Boolean(p.voided),
    localId: item.localId,
    deviceId: item.deviceId || device.deviceId,
    source: 'offline',
    syncedAt: new Date(),
    stockWarnings: warnings,
    createdAt,
  });

  const stockWarnings = [];
  for (const line of items) {
    if (!line.productId) continue;
    const product = byId.get(String(line.productId));
    if (!product) continue;

    const next = (Number(product.stock) || 0) - line.qty;
    if (next < 0) stockWarnings.push('STOCK_NEGATIVE');

    await Product.updateOne(
      { _id: product._id, tenantId },
      { $inc: { stock: -line.qty } }
    );
  }

  if (stockWarnings.length) {
    doc.stockWarnings = [...new Set([...warnings, ...stockWarnings])];
    await doc.save();
  }

  if (customerId && !doc.voided) {
    await Customer.updateOne(
      { _id: customerId, tenantId },
      {
        $inc: {
          totalSpent: total,
          visitCount: 1,
        },
        $set: { lastPurchaseAt: createdAt },
      }
    );
  }

  return { record: doc.toObject(), warnings: doc.stockWarnings || [] };
}

const push = asyncHandler(async (req, res) => {
  const { schemaVersion, items } = req.body || {};

  if (schemaVersion !== SCHEMA_VERSION) {
    throw ApiError.badRequest(
      'SCHEMA_MISMATCH',
      `Unsupported schemaVersion: ${schemaVersion}`
    );
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw ApiError.badRequest('NO_ITEMS', 'items array is required');
  }
  if (items.length > MAX_ITEMS_PER_PUSH) {
    throw ApiError.badRequest(
      'BATCH_TOO_LARGE',
      `Max ${MAX_ITEMS_PER_PUSH} items per push`
    );
  }

  const tenantId = req.tenantId;
  const branchId = req.branchId;
  const device = req.device;

  const results = [];
  const affectedProductIds = new Set();

  for (const item of items) {
    try {
      if (!item.localId || !item.type) {
        results.push({
          localId: item.localId || null,
          status: 'rejected',
          reason: 'MISSING_FIELDS',
        });
        continue;
      }

      const existing = await IdempotencyKey.findOne({
        tenantId,
        localId: item.localId,
      }).lean();
      if (existing) {
        results.push({
          localId: item.localId,
          status: 'duplicate',
          serverId: existing.serverId,
          type: existing.type,
        });
        continue;
      }

      let record;
      let warnings = [];

      if (item.type === 'customer') {
        const { record: doc } = await processCustomer({ tenantId, item });
        record = doc;
      } else if (item.type === 'sale') {
        const result = await processSale({
          tenantId,
          branchId,
          device,
          item,
        });
        record = result.record;
        warnings = result.warnings;

        for (const line of record.items || []) {
          if (line.productId) affectedProductIds.add(String(line.productId));
        }
      } else {
        results.push({
          localId: item.localId,
          status: 'rejected',
          reason: 'UNKNOWN_TYPE',
        });
        continue;
      }

      await IdempotencyKey.create({
        tenantId,
        localId: item.localId,
        serverId: String(record._id),
        type: item.type,
      });

      results.push({
        localId: item.localId,
        status: 'accepted',
        serverId: String(record._id),
        type: item.type,
        ...(warnings.length ? { warnings } : {}),
      });
    } catch (err) {
      logger.error(
        { err: err.message, localId: item.localId, type: item.type },
        'sync push item failed'
      );
      results.push({
        localId: item.localId,
        status: 'rejected',
        reason: err.code || 'PROCESSING_ERROR',
        message: err.message,
      });
    }
  }

  const stockUpdates = [];
  if (affectedProductIds.size > 0) {
    const fresh = await Product.find({
      _id: {
        $in: [...affectedProductIds].map(
          (id) => new mongoose.Types.ObjectId(id)
        ),
      },
      tenantId,
    })
      .select('_id stock')
      .lean();
    for (const prod of fresh) {
      stockUpdates.push({
        productId: String(prod._id),
        stock: Number(prod.stock) || 0,
      });
    }
  }

  Device.updateOne(
    { _id: device._id },
    { $set: { lastSyncAt: new Date() } }
  ).catch(() => {});

  return ok(res, {
    schemaVersion: SCHEMA_VERSION,
    serverTime: new Date().toISOString(),
    results,
    stockUpdates,
    conflicts: [],
  });
});

const registerDevice = asyncHandler(async (req, res) => {
  const { deviceId, deviceName, platform, appVersion, branchId } = req.body || {};

  if (!deviceId || typeof deviceId !== 'string') {
    throw ApiError.badRequest('MISSING_DEVICE', 'deviceId is required');
  }
  if (!branchId) {
    throw ApiError.badRequest('MISSING_BRANCH', 'branchId is required');
  }

  const doc = await Device.findOneAndUpdate(
    { tenantId: req.tenantId, deviceId },
    {
      $set: {
        deviceName: deviceName || 'Unnamed device',
        branchId,
        platform: platform || '',
        appVersion: appVersion || '',
        lastSeenAt: new Date(),
      },
      $setOnInsert: {
        tenantId: req.tenantId,
        deviceId,
      },
    },
    { upsert: true, new: true }
  );

  return ok(res, {
    registered: true,
    deviceId: doc.deviceId,
    branchId: String(doc.branchId),
    serverTime: new Date().toISOString(),
  });
});

module.exports = {
  pull,
  push,
  registerDevice,
  SCHEMA_VERSION,
};