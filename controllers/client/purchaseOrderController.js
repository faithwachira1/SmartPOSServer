const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created, paginated, noContent } = require('../../utils/apiResponse');
const { parsePagination } = require('../../utils/pagination');
const { assertObjectId } = require('../../utils/validateObjectId');
const { tenantFilter } = require('../../utils/tenantScope');
const { ApiError } = require('../../utils/apiError');
const PurchaseOrder = require('../../models/client/PurchaseOrder');
const Supplier = require('../../models/client/Supplier');
const Product = require('../../models/client/Product');
const InventoryMovement = require('../../models/client/InventoryMovement');
const Tenant = require('../../models/admin/Tenant');
const emailService = require('../../services/emailService');
const { logger } = require('../../utils/logger');

const whole = (n) => Math.round(Number(n) || 0);

function generatePoNumber() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `PO-${stamp}-${rand}`;
}

function shapePo(p) {
  return {
    id: p._id.toString(),
    poNumber: p.poNumber,
    supplierId: p.supplierId?.toString() || null,
    supplierSnapshot: p.supplierSnapshot || null,
    items: (p.items || []).map((i) => ({
      productId: i.productId?.toString() || null,
      name: i.name || null,
      sku: i.sku || null,
      qty: i.qty,
      unitCost: i.unitCost,
      subtotal: i.subtotal,
      receivedQty: i.receivedQty || 0,
      remaining: Math.max(0, i.qty - (i.receivedQty || 0)),
    })),
    subtotal: p.subtotal,
    tax: p.tax,
    shipping: p.shipping,
    total: p.total,
    currency: p.currency,
    status: p.status,
    notes: p.notes || null,
    expectedAt: p.expectedAt || null,
    sentAt: p.sentAt || null,
    receivedAt: p.receivedAt || null,
    cancelledAt: p.cancelledAt || null,
    cancelReason: p.cancelReason || null,
    createdBy: p.createdBy?.toString() || null,
    receivedBy: p.receivedBy?.toString() || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function resolveSupplier(tenantId, supplierId) {
  const supplier = await Supplier.findOne({
    _id: supplierId,
    tenantId,
    active: true,
  }).lean();
  if (!supplier) throw ApiError.badRequest('SUPPLIER_NOT_FOUND', 'Supplier not found');
  return supplier;
}

function buildItems(rawItems, productMap) {
  let subtotal = 0;
  const items = [];

  for (const raw of rawItems) {
    const qty = Number(raw.qty);
    const unitCost = whole(raw.unitCost);

    if (!qty || qty <= 0) continue;

    let productId = raw.productId || null;
    let name = raw.name ? String(raw.name).trim() : '';
    let sku = raw.sku ? String(raw.sku).trim() : null;

    if (productId) {
      const product = productMap[productId];
      if (!product) {
        throw ApiError.badRequest('PRODUCT_NOT_FOUND', `Product ${productId} not found`);
      }
      name = product.name;
      sku = product.sku || null;
    }

    if (!name) {
      throw ApiError.badRequest('ITEM_NAME_REQUIRED', 'Every item needs a name or productId');
    }

    const lineTotal = whole(unitCost * qty);
    subtotal += lineTotal;

    items.push({
      productId,
      name,
      sku,
      qty,
      unitCost,
      subtotal: lineTotal,
      receivedQty: 0,
    });
  }

  if (!items.length) {
    throw ApiError.badRequest('NO_ITEMS', 'Purchase order must have items');
  }

  return { items, subtotal: whole(subtotal) };
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = tenantFilter(req);

  if (req.query.status) filter.status = req.query.status;
  if (req.query.supplierId) filter.supplierId = req.query.supplierId;
  if (req.query.search) {
    const s = String(req.query.search).trim();
    filter.$or = [
      { poNumber: { $regex: s, $options: 'i' } },
      { 'supplierSnapshot.name': { $regex: s, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    PurchaseOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PurchaseOrder.countDocuments(filter),
  ]);

  return paginated(res, items.map(shapePo), page, limit, total);
});

const get = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'poId');
  const po = await PurchaseOrder.findOne(
    tenantFilter(req, { _id: req.params.id })
  ).lean();
  if (!po) throw ApiError.notFound('PO_NOT_FOUND', 'Purchase order not found');
  return ok(res, shapePo(po));
});

const create = asyncHandler(async (req, res) => {
  const { supplierId, items: rawItems, tax, shipping, notes, expectedAt } = req.body;

  if (!supplierId) throw ApiError.badRequest('SUPPLIER_REQUIRED', 'Supplier required');
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw ApiError.badRequest('NO_ITEMS', 'At least one item required');
  }

  const supplier = await resolveSupplier(req.tenantId, supplierId);

  const productIds = rawItems.map((i) => i.productId).filter(Boolean);
  const products = productIds.length
    ? await Product.find(tenantFilter(req, { _id: { $in: productIds } })).lean()
    : [];
  const productMap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));

  const { items, subtotal } = buildItems(rawItems, productMap);
  const taxAmt = whole(tax);
  const shippingAmt = whole(shipping);
  const total = whole(subtotal + taxAmt + shippingAmt);

  const tenant = await Tenant.findById(req.tenantId).lean();
  const currency = tenant?.settings?.currency || 'KES';

  const po = await PurchaseOrder.create({
    tenantId: req.tenantId,
    poNumber: generatePoNumber(),
    supplierId: supplier._id,
    supplierSnapshot: {
      name: supplier.name,
      phone: supplier.phone || null,
      email: supplier.email || null,
      address: supplier.address || null,
    },
    items,
    subtotal,
    tax: taxAmt,
    shipping: shippingAmt,
    total,
    currency,
    status: 'draft',
    notes: notes ? String(notes).trim() : null,
    expectedAt: expectedAt ? new Date(expectedAt) : null,
    createdBy: req.user.id,
  });

  return created(res, shapePo(po.toObject()));
});

const update = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'poId');

  const po = await PurchaseOrder.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!po) throw ApiError.notFound('PO_NOT_FOUND', 'Purchase order not found');
  if (po.status !== 'draft') {
    throw ApiError.badRequest('NOT_EDITABLE', 'Only draft purchase orders can be edited');
  }

  const { supplierId, items: rawItems, tax, shipping, notes, expectedAt } = req.body;

  if (supplierId) {
    const supplier = await resolveSupplier(req.tenantId, supplierId);
    po.supplierId = supplier._id;
    po.supplierSnapshot = {
      name: supplier.name,
      phone: supplier.phone || null,
      email: supplier.email || null,
      address: supplier.address || null,
    };
  }

  if (Array.isArray(rawItems)) {
    const productIds = rawItems.map((i) => i.productId).filter(Boolean);
    const products = productIds.length
      ? await Product.find(tenantFilter(req, { _id: { $in: productIds } })).lean()
      : [];
    const productMap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));

    const { items, subtotal } = buildItems(rawItems, productMap);
    po.items = items;
    po.subtotal = subtotal;
  }

  if (tax !== undefined) po.tax = whole(tax);
  if (shipping !== undefined) po.shipping = whole(shipping);
  po.total = whole((po.subtotal || 0) + (po.tax || 0) + (po.shipping || 0));

  if (notes !== undefined) po.notes = notes ? String(notes).trim() : null;
  if (expectedAt !== undefined) {
    po.expectedAt = expectedAt ? new Date(expectedAt) : null;
  }

  await po.save();
  return ok(res, shapePo(po.toObject()));
});

const send = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'poId');

  const po = await PurchaseOrder.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!po) throw ApiError.notFound('PO_NOT_FOUND', 'Purchase order not found');
  if (po.status !== 'draft') {
    throw ApiError.badRequest('NOT_DRAFT', 'Only draft purchase orders can be sent');
  }

  po.status = 'sent';
  po.sentAt = new Date();
  await po.save();

  if (po.supplierSnapshot?.email) {
    const tenant = await Tenant.findById(req.tenantId).lean();
    const currency = po.currency || 'KES';

    emailService
      .sendPurchaseOrderEmail(po.supplierSnapshot.email, {
        businessName: tenant?.name || 'SmartPOS',
        supplierName: po.supplierSnapshot.name,
        poNumber: po.poNumber,
        items: po.items.map((i) => ({
          name: i.name,
          qty: i.qty,
          unitCost: i.unitCost,
          subtotal: i.subtotal,
        })),
        subtotal: po.subtotal,
        tax: po.tax,
        shipping: po.shipping,
        total: po.total,
        currency,
        expectedAt: po.expectedAt
          ? new Date(po.expectedAt).toLocaleDateString('en-KE', {
              dateStyle: 'medium',
              timeZone: 'Africa/Nairobi',
            })
          : null,
        notes: po.notes,
        pdfUrl: po.pdfUrl || null,
        businessContact: {
          name: tenant?.name || 'SmartPOS',
          phone: tenant?.settings?.phone || null,
          email: tenant?.settings?.email || null,
        },
      })
      .catch((err) =>
        logger.error({ err: err.message, poId: po._id }, 'PO email failed')
      );
  }

  return ok(res, shapePo(po.toObject()));
});

const receive = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'poId');

  const po = await PurchaseOrder.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!po) throw ApiError.notFound('PO_NOT_FOUND', 'Purchase order not found');
  if (['received', 'cancelled'].includes(po.status)) {
    throw ApiError.badRequest('NOT_RECEIVABLE', `Cannot receive a ${po.status} purchase order`);
  }

  const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!incoming.length) {
    throw ApiError.badRequest('NO_ITEMS', 'At least one line to receive');
  }

  const notes = req.body?.notes ? String(req.body.notes).trim() : null;

  const byProductId = new Map();
  const byName = new Map();
  for (const raw of incoming) {
    if (raw.productId) byProductId.set(String(raw.productId), raw);
    if (raw.name) byName.set(String(raw.name).trim().toLowerCase(), raw);
  }

  const createdProducts = [];

  for (const poItem of po.items) {
    const key = poItem.productId ? String(poItem.productId) : null;
    const raw =
      (key && byProductId.get(key)) ||
      byName.get(String(poItem.name).trim().toLowerCase());

    if (!raw) continue;

    const requested = Number(raw.receivedQty) || 0;
    if (requested <= 0) continue;

    const alreadyReceived = poItem.receivedQty || 0;
    const remaining = Math.max(0, poItem.qty - alreadyReceived);
    if (remaining <= 0) continue;

    const receiveNow = Math.min(requested, remaining);

    let productId = poItem.productId;

    if (!productId) {
      if (!raw.createProduct) {
        throw ApiError.badRequest(
          'PRODUCT_REQUIRED',
          `Item "${poItem.name}" has no linked product. Provide createProduct details.`
        );
      }

      const newProductData = raw.newProduct || {};
      const name = String(newProductData.name || poItem.name).trim();
      const cost = whole(newProductData.cost ?? poItem.unitCost);
      const price = whole(newProductData.price ?? Math.ceil(cost * 1.3));
      const lowStockThreshold = Number(newProductData.lowStockThreshold) || 5;

      const product = await Product.create({
        tenantId: req.tenantId,
        name,
        sku: newProductData.sku ? String(newProductData.sku).trim() : poItem.sku || undefined,
        barcode: newProductData.barcode ? String(newProductData.barcode).trim() : undefined,
        category: newProductData.category ? String(newProductData.category).trim() : undefined,
        price,
        cost,
        stock: 0,
        lowStockThreshold,
        active: true,
        createdBy: req.user.id,
      });

      productId = product._id;
      poItem.productId = product._id;
      poItem.name = product.name;
      if (product.sku) poItem.sku = product.sku;

      createdProducts.push({
        id: product._id.toString(),
        name: product.name,
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      throw ApiError.badRequest(
        'PRODUCT_NOT_FOUND',
        `Linked product for "${poItem.name}" no longer exists`
      );
    }

    const newStock = (product.stock || 0) + receiveNow;
    product.stock = newStock;
    product.cost = whole(poItem.unitCost);
    await product.save();

    await InventoryMovement.create({
      tenantId: req.tenantId,
      productId: product._id,
      type: 'purchase',
      qty: receiveNow,
      reason: `Received against ${po.poNumber}`,
      refType: 'purchase_order',
      refId: po._id,
      userId: req.user.id,
      balanceAfter: newStock,
    });

    poItem.receivedQty = alreadyReceived + receiveNow;
  }

  const allReceived = po.items.every((i) => (i.receivedQty || 0) >= i.qty);
  const anyReceived = po.items.some((i) => (i.receivedQty || 0) > 0);

  if (allReceived) {
    po.status = 'received';
    po.receivedAt = new Date();
  } else if (anyReceived) {
    po.status = 'partial';
  }

  po.receivedBy = req.user.id;
  if (notes) {
    po.notes = po.notes ? `${po.notes}\n\nReceive note: ${notes}` : `Receive note: ${notes}`;
  }

  await po.save();

  return ok(res, {
    po: shapePo(po.toObject()),
    createdProducts,
  });
});

const cancel = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'poId');

  const po = await PurchaseOrder.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!po) throw ApiError.notFound('PO_NOT_FOUND', 'Purchase order not found');
  if (['received', 'cancelled'].includes(po.status)) {
    throw ApiError.badRequest('NOT_CANCELLABLE', `Cannot cancel a ${po.status} purchase order`);
  }

  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw ApiError.badRequest('REASON_REQUIRED', 'Cancel reason required');

  po.status = 'cancelled';
  po.cancelledAt = new Date();
  po.cancelReason = reason;
  await po.save();

  if (po.supplierSnapshot?.email) {
    const tenant = await Tenant.findById(req.tenantId).lean();
    emailService
      .sendPurchaseOrderCancelledEmail(po.supplierSnapshot.email, {
        businessName: tenant?.name || 'SmartPOS',
        supplierName: po.supplierSnapshot.name,
        poNumber: po.poNumber,
        reason,
      })
      .catch((err) =>
        logger.error({ err: err.message, poId: po._id }, 'PO cancel email failed')
      );
  }

  return ok(res, shapePo(po.toObject()));
});

const remove = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'poId');

  const po = await PurchaseOrder.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!po) throw ApiError.notFound('PO_NOT_FOUND', 'Purchase order not found');
  if (po.status !== 'draft') {
    throw ApiError.badRequest('NOT_DELETABLE', 'Only draft purchase orders can be deleted');
  }

  await PurchaseOrder.deleteOne({ _id: po._id });
  return noContent(res);
});

module.exports = { list, get, create, update, send, receive, cancel, remove };