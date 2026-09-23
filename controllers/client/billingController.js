const Plan = require('../../models/admin/Plan');
const Tenant = require('../../models/admin/Tenant');
const Payment = require('../../models/client/Payment');
const Subscription = require('../../models/admin/Subscription');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');

const getSubscription = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.tenantId).lean();
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const plan = await Plan.findOne({ code: tenant.planId }).lean();

  const history = await Subscription.find({ tenantId: tenant._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  const price = plan?.price || null;
  const currency = price?.currency || 'KES';

  return ok(res, {
    plan: {
      code: tenant.planId,
      name: plan?.name || tenant.planId || 'Unknown',
      description: plan?.description || null,
      price,
      features: plan?.features || {},
      limits: plan?.limits || {},
    },
    status: tenant.status || 'unknown',
    periodStart: tenant.registeredAt || tenant.createdAt || null,
    periodEnd: tenant.expiresAt || null,
    autoRenew: true,
    subscriptionCurrency: currency,
    history: history.map((s) => ({
      _id: s._id,
      plan: s.plan,
      cycle: s.cycle,
      status: s.status,
      amountMinor: s.amountMinor || 0,
      currency: s.currency,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      createdAt: s.createdAt,
    })),
  });
});

const listPayments = asyncHandler(async (req, res) => {
  const payments = await Payment.find({ tenantId: req.tenantId })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return ok(
    res,
    payments.map((p) => ({
      _id: p._id,
      amount: p.amount || 0,
      amountMinor: Math.round((p.amount || 0) * 100),
      currency: p.currency,
      method: p.method,
      status: p.status,
      reference: p.providerRef || null,
      purpose: p.invoiceId ? 'invoice' : 'sale',
      createdAt: p.createdAt,
      completedAt: p.status === 'success' ? p.updatedAt : null,
    }))
  );
});

module.exports = { getSubscription, listPayments };