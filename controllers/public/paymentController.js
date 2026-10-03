const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');
const { env } = require('../../config/env');
const paymentInstructionsService = require('../../services/paymentInstructionsService');
const mpesaService = require('../../services/mpesaService');
const Invoice = require('../../models/client/Invoice');
const Payment = require('../../models/client/Payment');
const Tenant = require('../../models/admin/Tenant');

function platformCreds() {
  if (
    !env.mpesa.consumerKey ||
    !env.mpesa.consumerSecret ||
    !env.mpesa.shortcode ||
    !env.mpesa.passkey
  ) {
    return null;
  }
  return {
    tenantId: 'platform',
    env: env.mpesa.env,
    shortcode: env.mpesa.shortcode,
    consumerKey: env.mpesa.consumerKey,
    consumerSecret: env.mpesa.consumerSecret,
    passkey: env.mpesa.passkey,
    callbackUrl: env.mpesa.callbackUrl,
    tillNumber: env.mpesa.tillNumber,
    transactionType: env.mpesa.transactionType,
    baseUrl: env.mpesa.baseUrl,
  };
}

const getMethods = asyncHandler(async (_req, res) => {
  const methods = await paymentInstructionsService.getPublicPaymentMethods();
  return ok(res, methods);
});

const sendStkForInvoice = asyncHandler(async (req, res) => {
  const { invoiceNumber, phone } = req.body;

  if (!invoiceNumber || !phone) {
    throw ApiError.badRequest('MISSING_FIELDS', 'invoiceNumber and phone required');
  }

  const invoice = await Invoice.findOne({ invoiceNumber }).lean();
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');

  if (invoice.status === 'paid') {
    throw ApiError.badRequest('ALREADY_PAID', 'This invoice is already paid');
  }
  if (invoice.status === 'cancelled') {
    throw ApiError.badRequest('INVOICE_CANCELLED', 'This invoice has been cancelled');
  }

  const tenant = await Tenant.findById(invoice.tenantId).lean();
  const isSubscriptionInvoice =
    !tenant ||
    tenant.status === 'pending_user' ||
    tenant.status === 'rejected';

  let creds;
  if (isSubscriptionInvoice) {
    creds = platformCreds();
  } else {
    creds = await mpesaService.resolveCreds(invoice.tenantId);
    if (!creds) creds = platformCreds();
  }

  if (!creds) {
    throw ApiError.internal(
      'MPESA_NOT_CONFIGURED',
      'M-Pesa credentials are not configured'
    );
  }

  const stk = await mpesaService.initiateSTKPush({
    phone,
    amount: invoice.amountDue,
    accountReference: invoice.invoiceNumber,
    description: isSubscriptionInvoice
      ? `Subscription ${invoice.invoiceNumber}`
      : `Payment for ${invoice.invoiceNumber}`,
    creds,
  });

  if (!stk.success) {
    throw ApiError.badRequest(
      'STK_FAILED',
      stk.error?.errorMessage || 'Could not initiate M-Pesa payment'
    );
  }

  await Invoice.updateOne(
    { _id: invoice._id },
    {
      $set: {
        stkLastRequest: {
          checkoutRequestId: stk.checkoutRequestId,
          phone,
          requestedAt: new Date(),
        },
      },
    }
  );

  await Payment.create({
    tenantId: invoice.tenantId,
    purpose: 'invoice',
    invoiceId: invoice._id,
    method: 'mpesa',
    amount: invoice.amountDue,
    currency: invoice.currency,
    status: 'pending',
    providerRef: stk.checkoutRequestId,
  });

  return created(res, {
    checkoutRequestId: stk.checkoutRequestId,
    message: stk.customerMessage,
  });
});

const checkStkStatus = asyncHandler(async (req, res) => {
  const { checkoutRequestId } = req.params;

  if (!checkoutRequestId) {
    throw ApiError.badRequest('MISSING_FIELDS', 'checkoutRequestId required');
  }

  const payment = await Payment.findOne({
    purpose: 'invoice',
    $or: [
      { providerRef: checkoutRequestId },
      { mpesaReceipt: checkoutRequestId },
    ],
  }).lean();

  if (!payment) {
    throw ApiError.notFound('PAYMENT_NOT_FOUND', 'Payment not found');
  }

  const invoice = payment.invoiceId
    ? await Invoice.findById(payment.invoiceId)
        .select('invoiceNumber status amountPaid amountDue currency')
        .lean()
    : null;

  return ok(res, {
    status: payment.status,
    invoiceNumber: invoice?.invoiceNumber || null,
    invoiceStatus: invoice?.status || null,
    amountPaid: invoice?.amountPaid || 0,
    amountDue: invoice?.amountDue || 0,
    currency: invoice?.currency || payment.currency,
    receipt: payment.mpesaReceipt || null,
    failureReason: payment.failureReason || null,
  });
});

module.exports = { getMethods, sendStkForInvoice, checkStkStatus };