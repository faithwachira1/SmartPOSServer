const rateLimit = require('express-rate-limit');
const { env } = require('../../config/env');

function skip(req) {
  if (!env.rateLimit.enabled) return true;
  if (req.path === '/health' || req.path === '/api/health') return true;
  return false;
}

function handler(_req, res) {
  res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
  });
}

const rateLimitMw = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  skip,
  handler,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
  },
});

const authRateLimitMw = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `auth:${req.ip}`,
  skip,
  handler,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many login attempts' },
  },
});

module.exports = { rateLimitMw, authRateLimitMw };