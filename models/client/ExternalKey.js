const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      unique: true,
    },
    keyHash: {
      type: String,
      required: true,
      unique: true,
    },
    prefix: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      default: 'Default key',
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

schema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.keyHash;
    return ret;
  },
});

module.exports = mongoose.model('ExternalKey', schema);