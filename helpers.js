'use strict';
const { createApp } = require('../src/app');

const KEYS = { viewer: 'viewer-key-123', agent: 'agent-key-123', admin: 'admin-key-123' };

// A clock the tests can move forward (breaker timeout, duplicate window, TTL, rate-limit window).
function makeClock(start = Date.parse('2026-10-10T10:00:00.000Z')) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

async function startApp(overrides = {}) {
  const app = createApp({ persist: false, logRequests: false, notifier: { latencyMs: 0 }, ...overrides });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}/api/v1`;

  async function call(method, path, { key, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (key) h['x-api-key'] = key;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  return { app, base, call, close: () => app.close() };
}

const ticketBody = (over = {}) => ({
  email: 'asha@example.com',
  title: 'Checkout page is down',
  description: 'Customers cannot pay, urgent fix needed.',
  category: 'outage',
  affectedUsers: 150,
  ...over,
});

module.exports = { startApp, makeClock, KEYS, ticketBody };
