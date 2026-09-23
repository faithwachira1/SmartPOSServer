const { ApiError } = require('../utils/apiError');

async function createPortalSession() {
  throw ApiError.badRequest('STRIPE_NOT_CONFIGURED', 'Stripe billing is not configured');
}

async function createCustomer() {
  throw ApiError.badRequest('STRIPE_NOT_CONFIGURED', 'Stripe billing is not configured');
}

async function createCheckoutSession() {
  throw ApiError.badRequest('STRIPE_NOT_CONFIGURED', 'Stripe billing is not configured');
}

async function refund() {
  throw ApiError.badRequest('STRIPE_NOT_CONFIGURED', 'Stripe billing is not configured');
}

async function getPriceId() {
  return null;
}

module.exports = {
  createPortalSession,
  createCustomer,
  createCheckoutSession,
  refund,
  getPriceId,
};