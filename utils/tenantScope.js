const mongoose = require('mongoose');
const { ApiError } = require('./apiError');

function tenantFilter(req, extra = {}) {
  const raw = req.user?.tenantId;
  if (!raw) {
    throw ApiError.forbidden('NO_TENANT', 'Tenant context missing');
  }

  const tenantId =
    raw instanceof mongoose.Types.ObjectId
      ? raw
      : new mongoose.Types.ObjectId(String(raw));

  return { tenantId, ...extra };
}

function requireTenantContext(req) {
  if (!req.user?.tenantId) {
    throw ApiError.forbidden('NO_TENANT', 'This route requires a tenant context');
  }
  return req.user.tenantId;
}

module.exports = { tenantFilter, requireTenantContext };