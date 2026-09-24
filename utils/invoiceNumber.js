const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomChunk(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  return `INV-${year}-${randomChunk(6)}`;
}

function generateSaleNumber() {
  const year = new Date().getFullYear();
  return `S-${year}-${randomChunk(6)}`;
}

function generatePoNumber() {
  const year = new Date().getFullYear();
  return `PO-${year}-${randomChunk(6)}`;
}

module.exports = {
  generateInvoiceNumber,
  generateSaleNumber,
  generatePoNumber,
  randomChunk,
};