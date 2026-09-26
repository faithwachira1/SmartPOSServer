const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    localId: { type: String, required: true },
    serverId: { type: String, required: true },
    type: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

schema.index({ tenantId: 1, localId: 1 }, { unique: true });
schema.index({ processedAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model('IdempotencyKey', schema);