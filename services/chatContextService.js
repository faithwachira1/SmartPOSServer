const mongoose = require('mongoose');
const Sale = require('../models/client/Sale');
const Product = require('../models/client/Product');
const Customer = require('../models/client/Customer');
const Tenant = require('../models/admin/Tenant');
const User = require('../models/client/User');

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d = new Date()) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? 6 : day - 1;
  x.setDate(x.getDate() - diff);
  return startOfDay(x);
}

function startOfMonth(d = new Date()) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function whole(n) {
  return Math.round(Number(n) || 0);
}

async function buildContext(tenantId) {
  const tid = new mongoose.Types.ObjectId(String(tenantId));
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  const tenant = await Tenant.findById(tid).lean();
  if (!tenant) return null;

  const [
    todayAgg,
    weekAgg,
    monthAgg,
    topToday,
    topWeek,
    lowStock,
    productCount,
    customerCount,
    recentSales,
    topCustomers,
    staffPerf,
    pendingInvoiceCount,
    cashierCount,
  ] = await Promise.all([
    Sale.aggregate([
      {
        $match: {
          tenantId: tid,
          createdAt: { $gte: todayStart, $lte: todayEnd },
          voided: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$total' },
          count: { $sum: 1 },
          discount: { $sum: '$discount' },
          tax: { $sum: '$tax' },
        },
      },
    ]),

    Sale.aggregate([
      {
        $match: {
          tenantId: tid,
          createdAt: { $gte: weekStart, $lte: todayEnd },
          voided: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$total' },
          count: { $sum: 1 },
        },
      },
    ]),

    Sale.aggregate([
      {
        $match: {
          tenantId: tid,
          createdAt: { $gte: monthStart, $lte: todayEnd },
          voided: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$total' },
          count: { $sum: 1 },
        },
      },
    ]),

    Sale.aggregate([
      {
        $match: {
          tenantId: tid,
          createdAt: { $gte: todayStart, $lte: todayEnd },
          voided: { $ne: true },
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          qty: { $sum: '$items.qty' },
          revenue: { $sum: '$items.subtotal' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),

    Sale.aggregate([
      {
        $match: {
          tenantId: tid,
          createdAt: { $gte: weekStart, $lte: todayEnd },
          voided: { $ne: true },
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          qty: { $sum: '$items.qty' },
          revenue: { $sum: '$items.subtotal' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),

    Product.find({
      tenantId: tid,
      active: true,
      $expr: { $lte: ['$stock', '$lowStockThreshold'] },
    })
      .select('name stock lowStockThreshold price')
      .sort({ stock: 1 })
      .limit(10)
      .lean(),

    Product.countDocuments({ tenantId: tid, active: true }),

    Customer.countDocuments({ tenantId: tid, active: true }),

    Sale.find({ tenantId: tid, voided: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('saleNumber total currency paymentMethod customerName createdAt')
      .lean(),

    Customer.find({ tenantId: tid, active: true })
      .sort({ totalSpent: -1 })
      .limit(5)
      .select('name totalSpent loyaltyPoints visitCount')
      .lean(),

    // Staff performance this month
    Sale.aggregate([
      {
        $match: {
          tenantId: tid,
          createdAt: { $gte: monthStart, $lte: todayEnd },
          voided: { $ne: true },
        },
      },
      {
        $group: {
          _id: '$cashierId',
          totalSales: { $sum: '$total' },
          transactions: { $sum: 1 },
          avgBasket: { $avg: '$total' },
        },
      },
      { $sort: { totalSales: -1 } },
      { $limit: 10 },
    ]).then(async (rows) => {
      const ids = rows.map((r) => r._id).filter(Boolean);
      const users = await User.find({ _id: { $in: ids } })
        .select('fullName role')
        .lean();
      const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

      return rows.map((r) => {
        const u = byId[r._id?.toString()];
        return {
          name: u?.fullName || 'Unknown',
          role: u?.role || null,
          totalSales: whole(r.totalSales),
          transactions: r.transactions,
          avgBasket: whole(r.avgBasket),
        };
      });
    }),

    mongoose.connection.db
      .collection('invoices')
      .countDocuments({
        tenantId: tid,
        status: { $in: ['sent', 'partial', 'overdue'] },
      })
      .catch(() => 0),

    mongoose.connection.db
      .collection('users')
      .countDocuments({
        tenantId: tid,
        status: 'active',
      })
      .catch(() => 0),
  ]);

  const today = todayAgg[0] || { total: 0, count: 0, discount: 0, tax: 0 };
  const week = weekAgg[0] || { total: 0, count: 0 };
  const month = monthAgg[0] || { total: 0, count: 0 };

  const currency = tenant.settings?.currency || 'KES';

  return {
    business: {
      name: tenant.name,
      country: tenant.country,
      businessType: tenant.businessType,
      currency,
      taxEnabled: tenant.settings?.taxEnabled === true,
      taxRate: Number(tenant.settings?.taxRate) || 0,
      loyaltyEnabled: tenant.settings?.loyaltyEnabled === true,
    },
    today: {
      totalSales: whole(today.total),
      transactions: today.count,
      avgBasket: today.count ? whole(today.total / today.count) : 0,
      discount: whole(today.discount),
      tax: whole(today.tax),
    },
    week: {
      totalSales: whole(week.total),
      transactions: week.count,
    },
    month: {
      totalSales: whole(month.total),
      transactions: month.count,
    },
    topProductsToday: topToday.map((p) => ({
      name: p._id,
      qty: p.qty,
      revenue: whole(p.revenue),
    })),
    topProductsWeek: topWeek.map((p) => ({
      name: p._id,
      qty: p.qty,
      revenue: whole(p.revenue),
    })),
    lowStock: lowStock.map((p) => ({
      name: p.name,
      stock: p.stock,
      threshold: p.lowStockThreshold,
      price: whole(p.price),
    })),
    counts: {
      activeProducts: productCount,
      activeCustomers: customerCount,
      staff: cashierCount,
      pendingInvoices: pendingInvoiceCount,
    },
    recentSales: recentSales.map((s) => ({
      saleNumber: s.saleNumber,
      total: whole(s.total),
      currency: s.currency,
      paymentMethod: s.paymentMethod || null,
      customerName: s.customerName || null,
      at: s.createdAt,
    })),
    topCustomers: topCustomers.map((c) => ({
      name: c.name,
      totalSpent: whole(c.totalSpent),
      loyaltyPoints: c.loyaltyPoints || 0,
      visits: c.visitCount || 0,
    })),
    staffPerformance: staffPerf,
    generatedAt: new Date().toISOString(),
  };
}

function formatContextForPrompt(ctx) {
  if (!ctx) return '';

  const cur = ctx.business.currency;
  const lines = [];

  lines.push(`BUSINESS CONTEXT (live data, updated ${new Date(ctx.generatedAt).toLocaleString()})`);
  lines.push('');
  lines.push(`Business: ${ctx.business.name} (${ctx.business.businessType}, ${ctx.business.country})`);
  lines.push(`Currency: ${cur}`);
  if (ctx.business.taxEnabled) {
    lines.push(`Tax: ${ctx.business.taxRate}% VAT is enabled`);
  } else {
    lines.push('Tax: VAT disabled');
  }
  if (ctx.business.loyaltyEnabled) {
    lines.push('Loyalty: enabled');
  }

  lines.push('');
  lines.push('TODAY:');
  lines.push(`- Sales: ${cur} ${ctx.today.totalSales.toLocaleString()} (${ctx.today.transactions} transactions)`);
  lines.push(`- Average basket: ${cur} ${ctx.today.avgBasket.toLocaleString()}`);
  if (ctx.today.discount > 0) lines.push(`- Discounts given: ${cur} ${ctx.today.discount.toLocaleString()}`);
  if (ctx.today.tax > 0) lines.push(`- Tax collected: ${cur} ${ctx.today.tax.toLocaleString()}`);

  lines.push('');
  lines.push('THIS WEEK:');
  lines.push(`- Sales: ${cur} ${ctx.week.totalSales.toLocaleString()} (${ctx.week.transactions} transactions)`);

  lines.push('');
  lines.push('THIS MONTH:');
  lines.push(`- Sales: ${cur} ${ctx.month.totalSales.toLocaleString()} (${ctx.month.transactions} transactions)`);

  if (ctx.topProductsToday.length) {
    lines.push('');
    lines.push('TOP PRODUCTS TODAY:');
    for (const p of ctx.topProductsToday) {
      lines.push(`- ${p.name}: ${p.qty} sold, ${cur} ${p.revenue.toLocaleString()}`);
    }
  }

  if (ctx.topProductsWeek.length) {
    lines.push('');
    lines.push('TOP PRODUCTS THIS WEEK:');
    for (const p of ctx.topProductsWeek) {
      lines.push(`- ${p.name}: ${p.qty} sold, ${cur} ${p.revenue.toLocaleString()}`);
    }
  }

  if (ctx.lowStock.length) {
    lines.push('');
    lines.push('LOW STOCK (needs restocking):');
    for (const p of ctx.lowStock) {
      lines.push(`- ${p.name}: ${p.stock} left (threshold ${p.threshold}, price ${cur} ${p.price})`);
    }
  } else {
    lines.push('');
    lines.push('LOW STOCK: none, all products above threshold');
  }

  if (ctx.recentSales.length) {
    lines.push('');
    lines.push('RECENT SALES:');
    for (const s of ctx.recentSales) {
      lines.push(
        `- ${s.saleNumber}: ${cur} ${s.total.toLocaleString()} via ${s.paymentMethod || 'unknown'}${s.customerName ? ` (${s.customerName})` : ''} at ${new Date(s.at).toLocaleTimeString()}`
      );
    }
  }

  if (ctx.topCustomers.length) {
    lines.push('');
    lines.push('TOP CUSTOMERS:');
    for (const c of ctx.topCustomers) {
      lines.push(`- ${c.name}: ${cur} ${c.totalSpent.toLocaleString()} spent, ${c.visits} visits, ${c.loyaltyPoints} points`);
    }
  }

  if (ctx.staffPerformance?.length) {
    lines.push('');
    lines.push('STAFF PERFORMANCE THIS MONTH:');
    for (const s of ctx.staffPerformance) {
      lines.push(
        `- ${s.name}${s.role ? ` (${s.role})` : ''}: ${cur} ${s.totalSales.toLocaleString()} across ${s.transactions} transactions (avg basket ${cur} ${s.avgBasket.toLocaleString()})`
      );
    }
    lines.push('');
    lines.push(
      `The top performer this month is ${ctx.staffPerformance[0].name} with ${cur} ${ctx.staffPerformance[0].totalSales.toLocaleString()} in sales.`
    );
  }

  lines.push('');
  lines.push('COUNTS:');
  lines.push(`- Active products: ${ctx.counts.activeProducts}`);
  lines.push(`- Active customers: ${ctx.counts.activeCustomers}`);
  lines.push(`- Staff: ${ctx.counts.staff}`);
  lines.push(`- Pending invoices: ${ctx.counts.pendingInvoices}`);

  return lines.join('\n');
}

module.exports = { buildContext, formatContextForPrompt };