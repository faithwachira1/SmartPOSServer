const { asyncHandler } = require('../../utils/asyncHandler');
const { ok } = require('../../utils/apiResponse');
const { ApiError } = require('../../utils/apiError');
const Tenant = require('../../models/admin/Tenant');
const User = require('../../models/client/User');
const cloudinaryService = require('../../services/cloudinaryService');

const get = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.tenantId).lean();
  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');

  const owner = await User.findOne({ tenantId: req.tenantId, role: 'owner' })
    .select('fullName email phone')
    .lean();

  return ok(res, {
    tenant: {
      id: tenant._id,
      name: tenant.name,
      slug: tenant.slug,
      country: tenant.country,
      businessType: tenant.businessType,
      status: tenant.status,
      planId: tenant.planId,
      settings: tenant.settings || {},
    },
    owner: owner
      ? {
          id: owner._id,
          fullName: owner.fullName,
          email: owner.email,
          phone: owner.phone || null,
        }
      : null,
  });
});

const update = asyncHandler(async (req, res) => {
  const tenantAllowed = ['name', 'country', 'businessType'];
  const settingsAllowed = [
    'currency',
    'taxRate',
    'taxInclusive',
    'receiptTemplate',
    'receiptFooter',
    'address',
    'phone',
    'email',
    'logoUrl',
    'logoPublicId',
  ];

  const tenantPatch = {};
  for (const k of tenantAllowed) {
    if (req.body[k] !== undefined) tenantPatch[k] = req.body[k];
  }

  const settingsPatch = {};
  for (const k of settingsAllowed) {
    if (req.body[k] !== undefined) settingsPatch[`settings.${k}`] = req.body[k];
  }

  const update = { $set: { ...tenantPatch, ...settingsPatch } };
  if (!Object.keys(update.$set).length) {
    throw ApiError.badRequest('NO_CHANGES', 'No valid fields to update');
  }

  const tenant = await Tenant.findByIdAndUpdate(req.tenantId, update, {
    new: true,
  }).lean();

  if (!tenant) throw ApiError.notFound('TENANT_NOT_FOUND', 'Tenant not found');
  return ok(res, tenant);
});

const updateMe = asyncHandler(async (req, res) => {
  const allowed = ['fullName', 'phone'];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  if (!Object.keys(patch).length) {
    throw ApiError.badRequest('NO_CHANGES', 'No valid fields to update');
  }

  const user = await User.findByIdAndUpdate(req.user.id, patch, { new: true })
    .select('-passwordHash')
    .lean();

  if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'User not found');
  return ok(res, {
    id: user._id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
  });
});

const uploadLogo = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('NO_FILE', 'File required');

  const folder = cloudinaryService.buildFolder(req.tenantId, 'logo');
  const result = await cloudinaryService.uploadBuffer(req.file.buffer, {
    folder,
    publicId: 'logo',
    resourceType: 'image',
  });

  await Tenant.updateOne(
    { _id: req.tenantId },
    {
      $set: {
        'settings.logoUrl': result.url,
        'settings.logoPublicId': result.publicId,
      },
    }
  );

  return ok(res, { url: result.url, publicId: result.publicId });
});

module.exports = { get, update, updateMe, uploadLogo };