const mongoose = require('mongoose');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok } = require('../../utils/apiResponse');
const { resolveDateRange } = require('../../utils/dateRange');
const Sale = require('../../models/client/Sale');
const Product = require('../../models/client/Product');
const Customer = require('../../models/client/Customer');
const PurchaseOrder = require('../../models/client/PurchaseOrder');
const InventoryMovement = require('../../models/client/InventoryMovement');
const User = require('../../models/client/User');

const DEAD_STOCK_DAYS = 30;

function oid(v) {
  return new mongoose.Types.ObjectId(v);
}

function baseMatch(req, start, end) {
  const match = {
    tenantId: oid(req.tenantId),
    createdAt: { $gte: start, $lte: end },
    voided: { $ne: true },
  };
  if (req.user.role === 'cashier') {
    match.cashierId = oid(req.user.id);
  }
  return match;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Existing reports
// ---------------------------------------------------------------------------

const salesSummary = asyncHandler(async (req, res) => {
  const { start, end } = resolveDateRange(req.query);

  const result = await Sale.aggregate([
    { $match: baseMatch(req, start, end) },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        totalTransactions: { $sum: 1 },
        totalDiscount: { $sum: '$discount' },
        totalTax: { $sum: '$tax' },
      },
    },
  ]);

  const summary = result[0] || {
    totalSales: 0,
    totalTransactions: 0,
    totalDiscount: 0,
    totalTax: 0,
  };

  return ok(res, {
    totalSales: summary.totalSales || 0,
    totalTransactions: summary.totalTransactions || 0,
    totalDiscount: summary.totalDiscount || 0,
    totalTax: summary.totalTax || 0,
    range: { start, end },
  });
});

const topProducts = asyncHandler(async (req, res) => {
  const { start, end } = resolveDateRange(req.query);
  const limit = Math.min(Number(req.query.limit) || 10, 100);

  const result = await Sale.aggregate([
    { $match: baseMatch(req, start, end) },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        name: { $first: '$items.name' },
        qty: { $sum: '$items.qty' },
        revenue: { $sum: '$items.subtotal' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);

  return ok(res, result);
});

const staff = asyncHandler(async (req, res) => {
  const { start, end } = resolveDateRange(req.query);

  const result = await Sale.aggregate([
    {
      $match: {
        tenantId: oid(req.tenantId),
        createdAt: { $gte: start, $lte: end },
        voided: { $ne: true },
      },
    },
    {
      $group: {
        _id: '$cashierId',
        totalSales: { $sum: '$total' },
        transactions: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'cashier',
      },
    },
    {
      $project: {
        _id: 1,
        cashierId: '$_id',
        cashierName: {
          $ifNull: [{ $arrayElemAt: ['$cashier.fullName', 0] }, 'Unknown'],
        },
        cashierEmail: {
          $ifNull: [{ $arrayElemAt: ['$cashier.email', 0] }, null],
        },
        totalSales: 1,
        transactions: 1,
        avgBasket: {
          $cond: [
            { $gt: ['$transactions', 0] },
            { $divide: ['$totalSales', '$transactions'] },
            0,
          ],
        },
      },
    },
    { $sort: { totalSales: -1 } },
  ]);

  return ok(res, result);
});

// ---------------------------------------------------------------------------
// NEW: Inventory
// ---------------------------------------------------------------------------

const inventory = asyncHandler(async (req, res) => {
  const tenantId = oid(req.tenantId);

  // Stock totals: qty + cost-value + retail-value, split by low-stock flag
  const products = await Product.find({ tenantId, active: true }).lean();

  let totalUnits = 0;
  let totalCostValue = 0;
  let totalRetailValue = 0;
  const lowStock = [];
  let outOfStockCount = 0;

  for (const p of products) {
    const qty = p.stock || 0;
    const cost = p.cost || 0;
    const price = p.price || 0;
    totalUnits += qty;
    totalCostValue += qty * cost;
    totalRetailValue += qty * price;

    if (qty === 0) outOfStockCount++;
    if (qty <= (p.lowStockThreshold || 0)) {
      lowStock.push({
        _id: p._id,
        name: p.name,
        sku: p.sku || null,
        stock: qty,
        lowStockThreshold: p.lowStockThreshold || 0,
      });
    }
  }

  lowStock.sort((a, b) => a.stock - b.stock);

  // Dead stock: products with no sale in the last DEAD_STOCK_DAYS
  const deadSince = new Date();
  deadSince.setDate(deadSince.getDate() - DEAD_STOCK_DAYS);

  const soldProductIds = await Sale.distinct('items.productId', {
    tenantId,
    createdAt: { $gte: deadSince },
    voided: { $ne: true },
    'items.productId': { $ne: null },
  });

  const soldSet = new Set(soldProductIds.map((id) => String(id)));
  const deadStock = products
    .filter((p) => (p.stock || 0) > 0 && !soldSet.has(String(p._id)))
    .map((p) => ({
      _id: p._id,
      name: p.name,
      sku: p.sku || null,
      stock: p.stock || 0,
      costValue: round2((p.stock || 0) * (p.cost || 0)),
    }))
    .sort((a, b) => b.costValue - a.costValue)
    .slice(0, 50);

  // Movement summary for the selected range
  const { start, end } = resolveDateRange(req.query);

  const movements = await InventoryMovement.aggregate([
    {
      $match: {
        tenantId,
        createdAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: '$type',
        qty: { $sum: '$qty' },
        count: { $sum: 1 },
      },
    },
    { $sort: { qty: -1 } },
  ]);

  return ok(res, {
    range: { start, end },
    totals: {
      products: products.length,
      totalUnits,
      totalCostValue: round2(totalCostValue),
      totalRetailValue: round2(totalRetailValue),
      potentialMargin: round2(totalRetailValue - totalCostValue),
      lowStockCount: lowStock.length,
      outOfStockCount,
      deadStockCount: deadStock.length,
    },
    lowStock: lowStock.slice(0, 50),
    deadStock,
    movements,
  });
});

// ---------------------------------------------------------------------------
// NEW: Customers
// ---------------------------------------------------------------------------

const customers = asyncHandler(async (req, res) => {
  const tenantId = oid(req.tenantId);
  const { start, end } = resolveDateRange(req.query);

  // New customers in range
  const newCustomers = await Customer.countDocuments({
    tenantId,
    createdAt: { $gte: start, $lte: end },
  });

  // Repeat-customer transactions in range (group by customerId)
  const customerSales = await Sale.aggregate([
    {
      $match: {
        tenantId,
        createdAt: { $gte: start, $lte: end },
        voided: { $ne: true },
        customerId: { $ne: null },
      },
    },
    {
      $group: {
        _id: '$customerId',
        totalSpent: { $sum: '$total' },
        transactions: { $sum: 1 },
        lastPurchaseAt: { $max: '$createdAt' },
      },
    },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer',
      },
    },
    {
      $project: {
        _id: 1,
        customerId: '$_id',
        name: {
          $ifNull: [{ $arrayElemAt: ['$customer.name', 0] }, 'Walk-in'],
        },
        phone: { $arrayElemAt: ['$customer.phone', 0] },
        email: { $arrayElemAt: ['$customer.email', 0] },
        totalSpent: 1,
        transactions: 1,
        lastPurchaseAt: 1,
        avgBasket: {
          $cond: [
            { $gt: ['$transactions', 0] },
            { $divide: ['$totalSpent', '$transactions'] },
            0,
          ],
        },
      },
    },
    { $sort: { totalSpent: -1 } },
  ]);

  // Split into one-time vs repeat within the range
  const repeatCustomers = customerSales.filter((c) => c.transactions > 1).length;
  const oneTimeCustomers = customerSales.filter((c) => c.transactions === 1).length;

  // Aggregate over ALL customers for lifetime value
  const ltvAgg = await Customer.aggregate([
    { $match: { tenantId, active: true } },
    {
      $group: {
        _id: null,
        totalCustomers: { $sum: 1 },
        avgLtv: { $avg: '$totalSpent' },
        totalLtv: { $sum: '$totalSpent' },
        withPurchases: {
          $sum: { $cond: [{ $gt: ['$visitCount', 0] }, 1, 0] },
        },
      },
    },
  ]);

  const ltv = ltvAgg[0] || {
    totalCustomers: 0,
    avgLtv: 0,
    totalLtv: 0,
    withPurchases: 0,
  };

  return ok(res, {
    range: { start, end },
    totals: {
      newCustomers,
      activeCustomers: customerSales.length,
      oneTimeCustomers,
      repeatCustomers,
      repeatRate:
        customerSales.length > 0
          ? round2((repeatCustomers / customerSales.length) * 100)
          : 0,
      totalCustomersEver: ltv.totalCustomers,
      avgLtv: round2(ltv.avgLtv),
      totalLtv: round2(ltv.totalLtv),
    },
    topCustomers: customerSales.slice(0, 25),
  });
});

// ---------------------------------------------------------------------------
// NEW: Suppliers & Purchase Orders
// ---------------------------------------------------------------------------

const suppliers = asyncHandler(async (req, res) => {
  const tenantId = oid(req.tenantId);
  const { start, end } = resolveDateRange(req.query);

  // Spend per supplier in range
  const bySupplier = await PurchaseOrder.aggregate([
    {
      $match: {
        tenantId,
        createdAt: { $gte: start, $lte: end },
        status: { $ne: 'cancelled' },
      },
    },
    {
      $group: {
        _id: '$supplierId',
        supplierName: { $first: '$supplierSnapshot.name' },
        poCount: { $sum: 1 },
        totalSpend: { $sum: '$total' },
        lastPoAt: { $max: '$createdAt' },
        receivedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'received'] }, 1, 0] },
        },
        cancelledCount: {
          $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] },
        },
      },
    },
    { $sort: { totalSpend: -1 } },
  ]);

  // Overall PO status breakdown
  const statusBreakdown = await PurchaseOrder.aggregate([
    {
      $match: {
        tenantId,
        createdAt: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } },
    { $sort: { count: -1 } },
  ]);

  // Overdue POs: expectedAt in the past, not received/partial/cancelled
  const overduePos = await PurchaseOrder.find({
    tenantId,
    expectedAt: { $lt: new Date() },
    status: { $in: ['draft', 'sent'] },
  })
    .select('poNumber supplierSnapshot total expectedAt status')
    .sort({ expectedAt: 1 })
    .limit(50)
    .lean();

  // Average lead time: sent -> received, for received POs
  const leadTimeAgg = await PurchaseOrder.aggregate([
    {
      $match: {
        tenantId,
        status: 'received',
        sentAt: { $ne: null },
        receivedAt: { $ne: null },
      },
    },
    {
      $project: {
        days: {
          $divide: [{ $subtract: ['$receivedAt', '$sentAt'] }, 1000 * 60 * 60 * 24],
        },
      },
    },
    { $group: { _id: null, avgDays: { $avg: '$days' }, count: { $sum: 1 } } },
  ]);

  const leadTime = leadTimeAgg[0] || { avgDays: 0, count: 0 };

  const totalSpend = bySupplier.reduce((s, x) => s + (x.totalSpend || 0), 0);
  const totalPos = bySupplier.reduce((s, x) => s + (x.poCount || 0), 0);

  return ok(res, {
    range: { start, end },
    totals: {
      supplierCount: bySupplier.length,
      totalPos,
      totalSpend: round2(totalSpend),
      avgPoValue: totalPos > 0 ? round2(totalSpend / totalPos) : 0,
      overdueCount: overduePos.length,
      avgLeadTimeDays: round2(leadTime.avgDays),
      leadTimeSampleSize: leadTime.count,
    },
    bySupplier,
    statusBreakdown,
    overduePos,
  });
});

// ---------------------------------------------------------------------------
// NEW: General (P&L snapshot)
// ---------------------------------------------------------------------------

const general = asyncHandler(async (req, res) => {
  const tenantId = oid(req.tenantId);
  const { start, end } = resolveDateRange(req.query);

  const match = {
    tenantId,
    createdAt: { $gte: start, $lte: end },
    voided: { $ne: true },
  };
  if (req.user.role === 'cashier') {
    match.cashierId = oid(req.user.id);
  }

  const salesAgg = await Sale.aggregate([
    { $match: match },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              revenue: { $sum: '$total' },
              subtotal: { $sum: '$subtotal' },
              discount: { $sum: '$discount' },
              tax: { $sum: '$tax' },
              transactions: { $sum: 1 },
            },
          },
        ],
        paymentSplit: [
          { $group: { _id: '$paymentMethod', amount: { $sum: '$total' }, count: { $sum: 1 } } },
          { $sort: { amount: -1 } },
        ],
        cogs: [
          { $unwind: '$items' },
          {
            $lookup: {
              from: 'products',
              localField: 'items.productId',
              foreignField: '_id',
              as: 'product',
            },
          },
          {
            $project: {
              cost: {
                $ifNull: [{ $arrayElemAt: ['$product.cost', 0] }, 0],
              },
              qty: '$items.qty',
            },
          },
          {
            $group: {
              _id: null,
              cogs: { $sum: { $multiply: ['$cost', '$qty'] } },
            },
          },
        ],
      },
    },
  ]);

  const summary = salesAgg[0]?.summary[0] || {
    revenue: 0,
    subtotal: 0,
    discount: 0,
    tax: 0,
    transactions: 0,
  };
  const paymentSplit = salesAgg[0]?.paymentSplit || [];
  const cogs = salesAgg[0]?.cogs[0]?.cogs || 0;

  const revenue = summary.revenue || 0;
  const grossProfit = revenue - cogs;
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  return ok(res, {
    range: { start, end },
    totals: {
      revenue: round2(revenue),
      subtotal: round2(summary.subtotal || 0),
      discount: round2(summary.discount || 0),
      tax: round2(summary.tax || 0),
      transactions: summary.transactions || 0,
      avgBasket:
        summary.transactions > 0 ? round2(revenue / summary.transactions) : 0,
      cogs: round2(cogs),
      grossProfit: round2(grossProfit),
      grossMargin: round2(grossMargin),
    },
    paymentSplit,
  });
});

// ---------------------------------------------------------------------------
// Existing CSV export (unchanged)
// ---------------------------------------------------------------------------

const exportData = asyncHandler(async (req, res) => {
  const { start, end } = resolveDateRange(req.query);

  const sales = await Sale.find({
    tenantId: req.tenantId,
    createdAt: { $gte: start, $lte: end },
  })
    .sort({ createdAt: -1 })
    .lean();

  const header = 'Sale Number,Date,Total,Payment Method,Status\n';
  const rows = sales
    .map(
      (s) =>
        `${s.saleNumber},${s.createdAt.toISOString()},${s.total},${s.paymentMethod || ''},${s.voided ? 'voided' : 'paid'}`
    )
    .join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sales.csv"');
  return res.send(header + rows);
});

module.exports = {
  salesSummary,
  topProducts,
  staff,
  inventory,
  customers,
  suppliers,
  general,
  exportData,
};