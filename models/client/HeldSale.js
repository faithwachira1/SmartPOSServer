const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    sku: String,
    qty: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true },
    subtotal: { type: Number, required: true },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    cashierId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    cashierName: { type: String, default: null },
    items: { type: [itemSchema], default: [] },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    vatAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    currency: { type: String, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerName: { type: String, default: null },
    loyaltyCardNumber: { type: String, default: null },
    label: { type: String, default: null },
    note: { type: String, default: null },
    expiresAt: { type: Date, required: true },

    localId: { type: String, sparse: true, index: true },
    deviceId: { type: String, sparse: true },
    syncedAt: { type: Date, default: null },
    source: { type: String, enum: ['live', 'offline'], default: 'live' },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, createdAt: -1 });
schema.index({ tenantId: 1, cashierId: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ tenantId: 1, localId: 1 }, { sparse: true });

schema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('HeldSale', schema);