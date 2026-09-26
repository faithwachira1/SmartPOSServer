const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    deviceId: { type: String, required: true },
    deviceName: { type: String, default: '' },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    platform: { type: String, default: '' },
    appVersion: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date, default: null },
    blocked: { type: Boolean, default: false },
    blockReason: { type: String, default: null },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, deviceId: 1 }, { unique: true });

schema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Device', schema);