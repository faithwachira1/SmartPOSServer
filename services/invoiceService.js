const Invoice = require('../models/client/Invoice');
const paymentInstructionsService = require('./paymentInstructionsService');
const { ApiError } = require('../utils/apiError');
const { logger } = require('../utils/logger');

const DUE_HOURS = 3;

async function nextInvoiceNumber(tenantId) {
  const count = await Invoice.countDocuments({ tenantId });
  const year = new Date().getFullYear();
  return `INV-${year}-${String(count + 1).padStart(4, '0')}`;
}

function intervalLabel(interval) {
  if (interval === 'once') return 'One-time';
  if (interval === 'year') return 'Annual';
  return 'Monthly';
}

async function generateRegistrationInvoice({ tenantId, owner, tenant, plan }) {
  if (!tenantId || !owner) {
    throw ApiError.badRequest('MISSING_FIELDS', 'tenantId and owner required');
  }

  const price = plan?.price || { amount: 0, currency: 'KES', interval: 'month' };
  const planName = plan?.name || 'Free';
  const label = intervalLabel(price.interval);

  const invoiceNumber = await nextInvoiceNumber(tenantId);
  const issuedAt = new Date();
  const dueDate = new Date(issuedAt.getTime() + DUE_HOURS * 60 * 60 * 1000);

  const items = [
    {
      productId: null,
      name: `SmartPOS ${planName} Plan`,
      description: `${label} · ${tenant.name}`,
      qty: 1,
      unitPrice: price.amount,
      subtotal: price.amount,
    },
  ];

  const subtotal = price.amount;
  const total = subtotal;

  const instructions = await paymentInstructionsService.getPaymentInstructions({
    amount: total,
    currency: price.currency,
    invoiceNumber,
  });

  const invoice = await Invoice.create({
    tenantId,
    invoiceNumber,
    customerId: null,
    customerSnapshot: {
      name: owner.fullName,
      email: owner.email,
      phone: owner.phone || null,
      address: null,
    },
    items,
    subtotal,
    discount: 0,
    tax: 0,
    total,
    amountPaid: 0,
    amountDue: total,
    currency: price.currency,
    status: 'sent',
    dueDate,
    issuedAt,
    sentAt: issuedAt,
    notes: `Registration invoice. Payment due within ${DUE_HOURS} hours to secure your account.`,
    paymentInstructions: instructions,
    createdBy: owner._id,
  });

  logger.info(
    {
      tenantId,
      invoiceNumber,
      total,
      dueDate,
      dueHours: DUE_HOURS,
      methodCount: instructions.length,
      planInterval: price.interval,
    },
    'registration invoice created'
  );

  return { invoice, instructions };
}

module.exports = { generateRegistrationInvoice, nextInvoiceNumber, DUE_HOURS };