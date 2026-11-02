'use strict';
const path = require('node:path');

// All values can be overridden with environment variables (see README) or,
// in tests, by passing overrides to createApp().
function defaults(env = process.env) {
  const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  return {
    port: num(env.PORT, 3000),
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
    persist: env.PERSIST !== 'false',
    logRequests: env.LOG_REQUESTS !== 'false',
    cors: env.CORS !== 'false',
    // Demo keys. Replace them with your own through env vars for anything real.
    apiKeys: {
      [env.VIEWER_KEY || 'viewer-key-123']: 'viewer',
      [env.AGENT_KEY || 'agent-key-123']: 'agent',
      [env.ADMIN_KEY || 'admin-key-123']: 'admin',
    },
    rateLimit: { windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60000), max: num(env.RATE_LIMIT_MAX, 100) },
    bodyLimitBytes: 10 * 1024,
    breaker: { failureThreshold: 3, resetMs: num(env.BREAKER_RESET_MS, 20000) },
    notifier: { latencyMs: num(env.NOTIFIER_LATENCY_MS, 300) },
    duplicateWindowMs: 10 * 60 * 1000,
    idempotencyTtlMs: 24 * 60 * 60 * 1000,
    now: () => Date.now(),
  };
}

function buildConfig(overrides = {}) {
  const base = defaults();
  return {
    ...base,
    ...overrides,
    rateLimit: { ...base.rateLimit, ...(overrides.rateLimit || {}) },
    breaker: { ...base.breaker, ...(overrides.breaker || {}) },
    notifier: { ...base.notifier, ...(overrides.notifier || {}) },
  };
}

module.exports = { buildConfig };
