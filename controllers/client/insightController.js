const mongoose = require('mongoose');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok } = require('../../utils/apiResponse');
const { resolveDateRange } = require('../../utils/dateRange');
const Sale = require('../../models/client/Sale');
const Product = require('../../models/client/Product');
const DailyMetric = require('../../models/client/DailyMetric');

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function computeToday(tenantId) {
  const now = new Date();
  const from = startOfDay(now);
  const to = endOfDay(now);

  const sales = await Sale.find({
    tenantId,
    createdAt: { $gte: from, $lte: to },
    voided: { $ne: true },
  }).lean();

  const totalSales = sales.reduce((sum, s) => sum + (s.total || 0), 0);
  const totalTransactions = sales.length;
  const avgBasket = totalTransactions ? totalSales / totalTransactions : 0;
  const grossProfit = sales.reduce((sum, s) => {
    return (
      sum +
      (s.items || []).reduce((sAcc, i) => sAcc + (i.subtotal || 0), 0) -
      (s.discount || 0)
    );
  }, 0);

  const productCount = {};
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0 }));
  const paymentSplit = {};

  for (const sale of sales) {
    for (const item of sale.items || []) {
      const key = String(item.productId || item.name);
      if (!productCount[key]) {
        productCount[key] = {
          productId: item.productId ? item.productId.toString() : null,
          name: item.name,
          qty: 0,
          revenue: 0,
        };
      }
      productCount[key].qty += item.qty || 0;
      productCount[key].revenue += item.subtotal || 0;
    }

    const hour = new Date(sale.createdAt).getHours();
    hourly[hour].sales += sale.total || 0;

    const method = sale.paymentMethod || 'unknown';
    paymentSplit[method] = (paymentSplit[method] || 0) + (sale.total || 0);
  }

  const topProducts = Object.values(productCount)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    _id: `live-${from.toISOString().slice(0, 10)}`,
    tenantId,
    date: from,
    totalSales: round2(totalSales),
    totalTransactions,
    avgBasket: round2(avgBasket),
    grossProfit: round2(grossProfit),
    topProducts,
    hourlyBreakdown: hourly,
    paymentSplit,
    live: true,
  };
}

const today = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = startOfDay(now);

  const [latestStored, lowStock] = await Promise.all([
    DailyMetric.findOne({ tenantId: req.tenantId, date: from }).lean(),
    Product.find({
      tenantId: req.tenantId,
      active: true,
      $expr: { $lte: ['$stock', '$lowStockThreshold'] },
    })
      .select('name stock lowStockThreshold')
      .limit(20)
      .lean(),
  ]);

  // Prefer live data — always accurate
  const live = await computeToday(req.tenantId);

  return ok(res, {
    latestMetric: live,
    storedMetric: latestStored || null,
    lowStock,
  });
});

const range = asyncHandler(async (req, res) => {
  const { start, end } = resolveDateRange(req.query);

  // Stored metrics for past days
  const stored = await DailyMetric.find({
    tenantId: req.tenantId,
    date: { $gte: start, $lte: end },
  })
    .sort({ date: 1 })
    .lean();

  // Add live metric for today if the range includes today
  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  const includesToday = start <= todayEnd && end >= todayStart;

  if (includesToday) {
    const todayMetric = await computeToday(req.tenantId);
    const withoutToday = stored.filter(
      (m) => startOfDay(m.date).getTime() !== todayStart.getTime()
    );
    return ok(res, [...withoutToday, todayMetric]);
  }

  return ok(res, stored);
});

const stockAlerts = asyncHandler(async (req, res) => {
  const products = await Product.find({
    tenantId: req.tenantId,
    active: true,
    $expr: { $lte: ['$stock', '$lowStockThreshold'] },
  })
    .select('name stock lowStockThreshold')
    .sort({ stock: 1 })
    .lean();

  return ok(res, products);
});

module.exports = { today, range, stockAlerts };