const crypto = require('crypto');
const { env } = require('../config/env');
const { ApiError } = require('./apiError');

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = env.mpesaEncryptionKey;
  if (!hex) {
    throw ApiError.internal('CRYPTO_NO_KEY', 'M_PESA_ENCRYPTION_KEY is not configured');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw ApiError.internal('CRYPTO_BAD_KEY', 'M_PESA_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return buf;
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(ciphertext) {
  if (!ciphertext) return '';
  const parts = String(ciphertext).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw ApiError.internal('CRYPTO_BAD_FORMAT', 'Invalid encrypted payload');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw ApiError.internal('CRYPTO_BAD_FORMAT', 'Invalid encrypted payload');
  }

  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    throw ApiError.internal('CRYPTO_DECRYPT_FAILED', 'Could not decrypt stored credentials — encryption key may have changed');
  }
}

function isEncrypted(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(`${VERSION}:`) &&
    value.split(':').length === 4
  );
}

function isMasked(value) {
  return typeof value === 'string' && value.startsWith('••••');
}

function maskSecret(plaintext) {
  if (!plaintext) return '';
  const s = String(plaintext);
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

module.exports = { encrypt, decrypt, isEncrypted, isMasked, maskSecret };