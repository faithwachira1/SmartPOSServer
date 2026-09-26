const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    position: {
      type: Number,
      default: 0,
    },

    deleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, name: 1 }, { unique: true });
schema.index({ tenantId: 1, position: 1 });
schema.index({ tenantId: 1, deleted: 1, updatedAt: -1 });

schema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Category', schema);