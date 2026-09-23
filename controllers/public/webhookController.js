const { asyncHandler } = require('../../utils/asyncHandler');
const { logger } = require('../../utils/logger');
const mpesaService = require('../../services/mpesaService');
const emailService = require('../../services/emailService');
const Payment = require('../../models/client/Payment');
const Sale = require('../../models/client/Sale');
const Invoice = require('../../models/client/Invoice');
const Tenant = require('../../models/admin/Tenant');
const User = require('../../models/client/User');
const Subscription = require('../../models/admin/Subscription');

async function notifyInvoicePaid(invoice, method, reference) {
  try {
    const tenant = await Tenant.findById(invoice.tenantId).lean();
    const owner = await User.findOne({ tenantId: invoice.tenantId, role: 'owner' })
      .select('email fullName')
      .lean();

    if (!owner?.email) return;

    await emailService.sendPaymentReceivedEmail(owner.email, {
      businessName: tenant?.name || 'SmartPOS',
      customerName: owner.fullName,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amountPaid,
      currency: invoice.currency,
      paidAt: invoice.paidAt?.toISOString() || new Date().toISOString(),
      paymentMethod: method,
      paymentReference: reference || null,
      notes: null,
    });

    logger.info(
      { invoiceNumber: invoice.invoiceNumber, method, reference },
      'paymentReceived email sent (callback)'
    );
  } catch (err) {
    logger.error(
      { err: err.message, invoiceNumber: invoice.invoiceNumber },
      'paymentReceived email failed'
    );
  }
}

async function handleSalePayment(payment, parsed) {
  if (!payment.saleId) return;

  await Sale.updateOne(
    { _id: payment.saleId },
    {
      $set: {
        paymentStatus: parsed.success ? 'paid' : 'failed',
        paidAt: parsed.success ? new Date() : null,
      },
    }
  );

  logger.info(
    {
      saleId: String(payment.saleId),
      success: parsed.success,
      receipt: parsed.mpesaReceiptNumber,
    },
    'STK callback: sale updated'
  );
}

async function handleInvoicePayment(payment, parsed) {
  let invoice = null;

  if (payment.invoiceId) {
    invoice = await Invoice.findById(payment.invoiceId);
  }

  if (!invoice) {
    invoice = await Invoice.findOne({
      'stkLastRequest.checkoutRequestId': parsed.checkoutRequestId,
    });
  }

  if (!invoice) return;

  if (parsed.success) {
    invoice.status = 'paid';
    invoice.amountPaid = invoice.amountDue;
    invoice.amountDue = 0;
    invoice.paidAt = new Date();
    invoice.paymentMethod = 'mpesa_stk';
    invoice.paymentRef = parsed.mpesaReceiptNumber || null;
    await invoice.save();

    logger.info(
      {
        invoiceNumber: invoice.invoiceNumber,
        receipt: parsed.mpesaReceiptNumber,
        amount: parsed.amount,
      },
      'invoice paid via STK callback'
    );

    notifyInvoicePaid(invoice, 'mpesa_stk', parsed.mpesaReceiptNumber).catch(
      () => {}
    );
  } else {
    logger.warn(
      { invoiceNumber: invoice.invoiceNumber, resultDesc: parsed.resultDesc },
      'STK payment failed for invoice'
    );
  }
}

async function handleSubscriptionPayment(payment, parsed) {
  if (!parsed.success) {
    logger.warn(
      { tenantId: String(payment.tenantId), resultDesc: parsed.resultDesc },
      'STK subscription payment failed'
    );
    return;
  }

  const tenant = await Tenant.findById(payment.tenantId);
  if (!tenant) return;

  const now = new Date();
  const existingExpiry = tenant.expiresAt ? new Date(tenant.expiresAt) : null;
  const base = existingExpiry && existingExpiry > now ? existingExpiry : now;
  const nextExpiry = new Date(base);
  nextExpiry.setMonth(nextExpiry.getMonth() + 1);

  tenant.expiresAt = nextExpiry;
  if (tenant.status === 'expired') tenant.status = 'active';
  await tenant.save();

  await Subscription.create({
    tenantId: tenant._id,
    plan: tenant.planId,
    cycle: 'month',
    status: 'active',
    amountMinor: Math.round((payment.amount || 0) * 100),
    currency: payment.currency,
    periodStart: base,
    periodEnd: nextExpiry,
    autoRenew: false,
    metadata: {
      paymentId: payment._id,
      providerRef: payment.providerRef,
      mpesaReceipt: parsed.mpesaReceiptNumber || null,
    },
  });

  logger.info(
    {
      tenantId: String(tenant._id),
      receipt: parsed.mpesaReceiptNumber,
      expiresAt: nextExpiry,
    },
    'subscription extended via STK callback'
  );
}

const mpesaCallback = asyncHandler(async (req, res) => {
  const payload = req.body;
  const parsed = mpesaService.parseCallback(payload);

  if (!parsed.checkoutRequestId) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const payment = await Payment.findOne({
    providerRef: parsed.checkoutRequestId,
  });

  if (payment) {
    payment.status = parsed.success ? 'success' : 'failed';
    payment.providerPayload = payload;
    if (parsed.success && parsed.mpesaReceiptNumber) {
      payment.providerRef = parsed.mpesaReceiptNumber;
    }
    await payment.save();

    try {
      if (payment.purpose === 'subscription') {
        await handleSubscriptionPayment(payment, parsed);
      } else if (payment.purpose === 'invoice') {
        await handleInvoicePayment(payment, parsed);
      } else {
        await handleSalePayment(payment, parsed);
      }
    } catch (err) {
      logger.error(
        {
          err: err.message,
          paymentId: String(payment._id),
          purpose: payment.purpose,
        },
        'STK callback dispatch failed'
      );
    }
  } else {
    const invoice = await Invoice.findOne({
      'stkLastRequest.checkoutRequestId': parsed.checkoutRequestId,
    });
    if (invoice) {
      await handleInvoicePayment(
        { invoiceId: invoice._id, tenantId: invoice.tenantId },
        parsed
      );
    } else {
      logger.warn(
        { checkoutRequestId: parsed.checkoutRequestId },
        'STK callback: no matching payment or invoice'
      );
    }
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

const mpesaTimeout = asyncHandler(async (req, res) => {
  logger.warn({ body: req.body }, 'mpesa timeout');
  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

const stripeWebhook = asyncHandler(async (req, res) => {
  logger.info('stripe webhook received');
  return res.status(200).json({ received: true });
});

const paystackWebhook = asyncHandler(async (req, res) => {
  logger.info('paystack webhook received');
  return res.status(200).json({ received: true });
});

const flutterwaveWebhook = asyncHandler(async (req, res) => {
  logger.info('flutterwave webhook received');
  return res.status(200).json({ received: true });
});

module.exports = {
  mpesaCallback,
  mpesaTimeout,
  stripeWebhook,
  paystackWebhook,
  flutterwaveWebhook,
};