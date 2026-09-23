const mongoose = require('mongoose');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ok, created, paginated, noContent } = require('../../utils/apiResponse');
const { parsePagination } = require('../../utils/pagination');
const { assertObjectId } = require('../../utils/validateObjectId');
const { tenantFilter } = require('../../utils/tenantScope');
const { ApiError } = require('../../utils/apiError');
const Invoice = require('../../models/client/Invoice');
const Customer = require('../../models/client/Customer');
const Tenant = require('../../models/admin/Tenant');
const emailService = require('../../services/emailService');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');

const whole = (n) => Math.round(Number(n) || 0);

function generateInvoiceNumber() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `INV-${stamp}-${rand}`;
}

function shapeInvoice(i) {
  return {
    id: i._id.toString(),
    invoiceNumber: i.invoiceNumber,
    customerId: i.customerId?.toString() || null,
    customerSnapshot: i.customerSnapshot || null,
    items: (i.items || []).map((item) => ({
      productId: item.productId?.toString() || null,
      name: item.name,
      description: item.description || null,
      qty: item.qty,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
    })),
    subtotal: i.subtotal,
    discount: i.discount || 0,
    tax: i.tax || 0,
    total: i.total,
    amountPaid: i.amountPaid || 0,
    amountDue: i.amountDue,
    currency: i.currency,
    status: i.status,
    dueDate: i.dueDate || null,
    issuedAt: i.issuedAt || null,
    sentAt: i.sentAt || null,
    paidAt: i.paidAt || null,
    cancelledAt: i.cancelledAt || null,
    cancelReason: i.cancelReason || null,
    paymentMethod: i.paymentMethod || null,
    paymentRef: i.paymentRef || null,
    notes: i.notes || null,
    remindersSent: i.remindersSent || 0,
    lastReminderAt: i.lastReminderAt || null,
    pdfUrl: i.pdfUrl || null,
    createdBy: i.createdBy?.toString() || null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function buildItems(rawItems) {
  let subtotal = 0;
  const items = [];

  for (const raw of rawItems) {
    const qty = Number(raw.qty);
    const unitPrice = whole(raw.unitPrice);
    if (!qty || qty <= 0) continue;

    const name = String(raw.name || '').trim();
    if (!name) throw ApiError.badRequest('ITEM_NAME_REQUIRED', 'Every item needs a name');

    const lineTotal = whole(unitPrice * qty);
    subtotal += lineTotal;

    items.push({
      productId: raw.productId || null,
      name,
      description: raw.description ? String(raw.description).trim() : null,
      qty,
      unitPrice,
      subtotal: lineTotal,
    });
  }

  if (!items.length) throw ApiError.badRequest('NO_ITEMS', 'Invoice must have at least one item');
  return { items, subtotal: whole(subtotal) };
}

async function resolveCustomer(req, customerId, snapshotInput) {
  if (customerId) {
    const customer = await Customer.findOne(
      tenantFilter(req, { _id: customerId, active: true })
    ).lean();
    if (!customer) throw ApiError.badRequest('CUSTOMER_NOT_FOUND', 'Customer not found');
    return {
      customerId: customer._id,
      customerSnapshot: {
        name: customer.name,
        email: customer.email || null,
        phone: customer.phone || null,
        address: customer.address || null,
      },
    };
  }

  if (snapshotInput?.name) {
    return {
      customerId: null,
      customerSnapshot: {
        name: String(snapshotInput.name).trim(),
        email: snapshotInput.email ? String(snapshotInput.email).trim().toLowerCase() : null,
        phone: snapshotInput.phone ? String(snapshotInput.phone).trim() : null,
        address: snapshotInput.address ? String(snapshotInput.address).trim() : null,
      },
    };
  }

  throw ApiError.badRequest('CUSTOMER_REQUIRED', 'Pick a customer or provide a snapshot');
}

function refreshStatus(invoice) {
  if (invoice.status === 'cancelled') return invoice.status;
  const now = new Date();

  if (invoice.amountPaid >= invoice.total) return 'paid';
  if (invoice.amountPaid > 0) return 'partial';

  if (invoice.dueDate && now > invoice.dueDate && invoice.status === 'sent') {
    return 'overdue';
  }
  return invoice.status;
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = tenantFilter(req);

  if (req.query.status) filter.status = req.query.status;
  if (req.query.customerId) filter.customerId = req.query.customerId;
  if (req.query.search) {
    const s = String(req.query.search).trim();
    filter.$or = [
      { invoiceNumber: { $regex: s, $options: 'i' } },
      { 'customerSnapshot.name': { $regex: s, $options: 'i' } },
      { 'customerSnapshot.email': { $regex: s, $options: 'i' } },
    ];
  }
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }

  const [items, total] = await Promise.all([
    Invoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Invoice.countDocuments(filter),
  ]);

  return paginated(res, items.map(shapeInvoice), page, limit, total);
});

const get = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'invoiceId');
  const invoice = await Invoice.findOne(
    tenantFilter(req, { _id: req.params.id })
  ).lean();
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');
  return ok(res, shapeInvoice(invoice));
});

const create = asyncHandler(async (req, res) => {
  const {
    customerId,
    customerSnapshot,
    items: rawItems,
    discount,
    tax,
    dueDate,
    notes,
    paymentInstructions,
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw ApiError.badRequest('NO_ITEMS', 'At least one item required');
  }

  const { customerId: resolvedCustomerId, customerSnapshot: resolvedSnapshot } =
    await resolveCustomer(req, customerId, customerSnapshot);

  const { items, subtotal } = buildItems(rawItems);
  const discountAmt = whole(discount);
  const taxAmt = whole(tax);
  const total = Math.max(0, whole(subtotal - discountAmt + taxAmt));

  const tenant = await Tenant.findById(req.tenantId).lean();
  const currency = tenant?.settings?.currency || 'KES';

  const invoice = await Invoice.create({
    tenantId: req.tenantId,
    invoiceNumber: generateInvoiceNumber(),
    customerId: resolvedCustomerId,
    customerSnapshot: resolvedSnapshot,
    items,
    subtotal,
    discount: discountAmt,
    tax: taxAmt,
    total,
    amountPaid: 0,
    amountDue: total,
    currency,
    status: 'draft',
    dueDate: dueDate ? new Date(dueDate) : null,
    issuedAt: null,
    notes: notes ? String(notes).trim() : null,
    paymentInstructions: Array.isArray(paymentInstructions) ? paymentInstructions : [],
    createdBy: req.user.id,
  });

  return created(res, shapeInvoice(invoice.toObject()));
});

const update = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'invoiceId');

  const invoice = await Invoice.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');
  if (!['draft', 'sent'].includes(invoice.status)) {
    throw ApiError.badRequest(
      'NOT_EDITABLE',
      `Cannot edit a ${invoice.status} invoice`
    );
  }

  const {
    customerId,
    customerSnapshot,
    items: rawItems,
    discount,
    tax,
    dueDate,
    notes,
    paymentInstructions,
  } = req.body;

  if (customerId !== undefined || customerSnapshot !== undefined) {
    const resolved = await resolveCustomer(req, customerId, customerSnapshot);
    invoice.customerId = resolved.customerId;
    invoice.customerSnapshot = resolved.customerSnapshot;
  }

  if (Array.isArray(rawItems)) {
    const { items, subtotal } = buildItems(rawItems);
    invoice.items = items;
    invoice.subtotal = subtotal;
  }

  if (discount !== undefined) invoice.discount = whole(discount);
  if (tax !== undefined) invoice.tax = whole(tax);
  invoice.total = Math.max(
    0,
    whole((invoice.subtotal || 0) - (invoice.discount || 0) + (invoice.tax || 0))
  );
  invoice.amountDue = Math.max(0, invoice.total - (invoice.amountPaid || 0));

  if (dueDate !== undefined) invoice.dueDate = dueDate ? new Date(dueDate) : null;
  if (notes !== undefined) invoice.notes = notes ? String(notes).trim() : null;
  if (Array.isArray(paymentInstructions)) {
    invoice.paymentInstructions = paymentInstructions;
  }

  invoice.status = refreshStatus(invoice);

  await invoice.save();
  return ok(res, shapeInvoice(invoice.toObject()));
});

const send = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'invoiceId');

  const invoice = await Invoice.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');
  if (invoice.status !== 'draft') {
    throw ApiError.badRequest('NOT_DRAFT', 'Only draft invoices can be sent');
  }
  if (!invoice.customerSnapshot?.email) {
    throw ApiError.badRequest('NO_EMAIL', 'Invoice has no customer email to send to');
  }

  const now = new Date();
  invoice.status = 'sent';
  invoice.sentAt = now;
  invoice.issuedAt = invoice.issuedAt || now;
  await invoice.save();

  const tenant = await Tenant.findById(req.tenantId).lean();
  const brand = tenant?.name || 'SmartPOS';
  const payUrl = `${env.appUrl}/invoice/${invoice.invoiceNumber}`;

  const dueDateHuman = invoice.dueDate
    ? invoice.dueDate.toLocaleString('en-KE', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Africa/Nairobi',
      })
    : null;
  const issuedAtHuman = invoice.issuedAt
    ? invoice.issuedAt.toLocaleString('en-KE', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Africa/Nairobi',
      })
    : null;

  emailService
    .sendInvoiceEmail(invoice.customerSnapshot.email, {
      businessName: brand,
      customerName: invoice.customerSnapshot.name,
      invoiceNumber: invoice.invoiceNumber,
      items: invoice.items.map((i) => ({
        name: i.name,
        description: i.description,
        qty: i.qty,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
      })),
      subtotal: invoice.subtotal,
      discount: invoice.discount,
      tax: invoice.tax,
      total: invoice.total,
      amountDue: invoice.amountDue,
      currency: invoice.currency,
      dueDate: dueDateHuman,
      issuedAt: issuedAtHuman,
      status: 'sent',
      notes: invoice.notes,
      instructions: invoice.paymentInstructions,
      payUrl,
      businessContact: {
        name: brand,
        email: tenant?.settings?.email || null,
        phone: tenant?.settings?.phone || null,
        website: tenant?.settings?.website || null,
      },
    })
    .catch((err) =>
      logger.error({ err: err.message, invoiceId: invoice._id }, 'invoice email failed')
    );

  return ok(res, shapeInvoice(invoice.toObject()));
});

const recordPayment = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'invoiceId');

  const invoice = await Invoice.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');
  if (invoice.status === 'cancelled') {
    throw ApiError.badRequest('CANCELLED', 'Cannot record payment on a cancelled invoice');
  }

  const amount = whole(req.body.amount);
  if (amount <= 0) throw ApiError.badRequest('INVALID_AMOUNT', 'Amount must be positive');

  const method = String(req.body.method || '').trim();
  if (!method) throw ApiError.badRequest('METHOD_REQUIRED', 'Payment method required');

  const reference = req.body.reference ? String(req.body.reference).trim() : null;
  const note = req.body.note ? String(req.body.note).trim() : null;

  const newPaid = Math.min(invoice.total, (invoice.amountPaid || 0) + amount);
  const newDue = Math.max(0, invoice.total - newPaid);

  invoice.amountPaid = newPaid;
  invoice.amountDue = newDue;
  invoice.paymentMethod = method;
  invoice.paymentRef = reference || invoice.paymentRef || null;

  if (note) {
    invoice.notes = invoice.notes
      ? `${invoice.notes}\nPayment: ${note}`
      : `Payment: ${note}`;
  }

  if (newDue === 0) {
    invoice.status = 'paid';
    invoice.paidAt = new Date();
  } else {
    invoice.status = 'partial';
  }

  await invoice.save();

  return ok(res, shapeInvoice(invoice.toObject()));
});

const cancel = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'invoiceId');

  const invoice = await Invoice.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');
  if (invoice.status === 'cancelled') {
    throw ApiError.badRequest('ALREADY_CANCELLED', 'Invoice already cancelled');
  }
  if (invoice.status === 'paid') {
    throw ApiError.badRequest('ALREADY_PAID', 'Cannot cancel a paid invoice');
  }

  const reason = String(req.body.reason || '').trim();
  if (!reason) throw ApiError.badRequest('REASON_REQUIRED', 'Cancel reason required');

  invoice.status = 'cancelled';
  invoice.cancelledAt = new Date();
  invoice.cancelReason = reason;
  await invoice.save();

  if (invoice.customerSnapshot?.email) {
    const tenant = await Tenant.findById(req.tenantId).lean();
    emailService
      .sendInvoiceCancelledEmail(invoice.customerSnapshot.email, {
        businessName: tenant?.name || 'SmartPOS',
        customerName: invoice.customerSnapshot.name,
        invoiceNumber: invoice.invoiceNumber,
        reason,
      })
      .catch((err) =>
        logger.error({ err: err.message, invoiceId: invoice._id }, 'invoice cancel email failed')
      );
  }

  return ok(res, shapeInvoice(invoice.toObject()));
});

const remind = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'invoiceId');

  const invoice = await Invoice.findOne(tenantFilter(req, { _id: req.params.id }));
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');
  if (['paid', 'cancelled', 'draft'].includes(invoice.status)) {
    throw ApiError.badRequest('NOT_REMINDABLE', `Cannot remind on a ${invoice.status} invoice`);
  }
  if (!invoice.customerSnapshot?.email) {
    throw ApiError.badRequest('NO_EMAIL', 'Invoice has no customer email');
  }

  const tenant = await Tenant.findById(req.tenantId).lean();
  const brand = tenant?.name || 'SmartPOS';

  const daysOverdue =
    invoice.status === 'overdue' && invoice.dueDate
      ? Math.max(0, Math.floor((Date.now() - invoice.dueDate.getTime()) / (24 * 60 * 60 * 1000)))
      : 0;

  const dueDateHuman = invoice.dueDate
    ? invoice.dueDate.toLocaleDateString('en-KE', {
        dateStyle: 'medium',
        timeZone: 'Africa/Nairobi',
      })
    : null;

  const payUrl = `${env.appUrl}/invoice/${invoice.invoiceNumber}`;

  const sendFn =
    invoice.status === 'overdue'
      ? emailService.sendInvoiceOverdueEmail
      : emailService.sendInvoiceReminderEmail;

  await sendFn.call(emailService, invoice.customerSnapshot.email, {
    businessName: brand,
    customerName: invoice.customerSnapshot.name,
    invoiceNumber: invoice.invoiceNumber,
    total: invoice.amountDue || invoice.total,
    currency: invoice.currency,
    dueDate: dueDateHuman,
    daysOverdue,
    paymentLink: payUrl,
  });

  invoice.remindersSent = (invoice.remindersSent || 0) + 1;
  invoice.lastReminderAt = new Date();
  await invoice.save();

  return ok(res, { sent: true, remindersSent: invoice.remindersSent });
});

const pdf = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'invoiceId');

  const invoice = await Invoice.findOne(tenantFilter(req, { _id: req.params.id })).lean();
  if (!invoice) throw ApiError.notFound('INVOICE_NOT_FOUND', 'Invoice not found');

  if (invoice.pdfUrl) {
    return ok(res, { url: invoice.pdfUrl });
  }

  return ok(res, { url: null, message: 'PDF not generated yet' });
});

module.exports = {
  list,
  get,
  create,
  update,
  send,
  recordPayment,
  cancel,
  remind,
  pdf,
};