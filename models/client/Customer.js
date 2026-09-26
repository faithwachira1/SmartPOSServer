const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    address: String,
    notes: String,
    loyaltyCardNumber: { type: String, trim: true },
    totalSpent: { type: Number, default: 0 },
    loyaltyPoints: { type: Number, default: 0 },
    visitCount: { type: Number, default: 0 },
    lastPurchaseAt: Date,
    active: { type: Boolean, default: true },

    localId: { type: String, sparse: true, index: true },
    deviceId: { type: String, sparse: true },
    deleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, phone: 1 });
schema.index({ tenantId: 1, email: 1 });
schema.index({ tenantId: 1, name: 1 });
schema.index({ tenantId: 1, loyaltyCardNumber: 1 }, { sparse: true });
schema.index({ tenantId: 1, localId: 1 }, { sparse: true });
schema.index({ tenantId: 1, deleted: 1, updatedAt: -1 });

schema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Customer', schema);