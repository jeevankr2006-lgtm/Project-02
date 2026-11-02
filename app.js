'use strict';
// THE GATEWAY. One entry point that centralises the cross-cutting concerns,
// then hands the request to the module that owns the job.
//
// Pipeline (IPO model):
//   INPUT   1 request id  2 rate limit  3 authN  4 authZ  5 gatekeeper (body parse + validation in handler)
//   PROCESS 6 idempotency 7 triage      8 persist 9 notify (through the circuit breaker)
//   OUTPUT  10 respond    11 record metrics
const http = require('node:http');
const fs = require('node:fs/promises');
const nodePath = require('node:path');
const { buildConfig } = require('./config');
const { ApiError } = require('./errors');
const { readBody } = require('./http');
const { Router } = require('./router');
const { buildRegistry } = require('./routes');
const { resolveRequestId } = require('./gateway/requestId');
const { RateLimiter } = require('./gateway/rateLimit');
const { authenticate, authorize } = require('./gateway/auth');
const { Metrics } = require('./gateway/metrics');
const { toErrorResponse } = require('./gateway/errorHandler');
const { TicketStore } = require('./modules/tickets/store');
const { IdempotencyStore } = require('./modules/tickets/idempotency');
const { CircuitBreaker } = require('./modules/notifier/circuitBreaker');
const { Notifier } = require('./modules/notifier/notifier');
const { iso } = require('./util');

const API_PREFIX = '/api/v1';
const PUBLIC_DIR = nodePath.join(__dirname, '..', 'public');
// The dashboard files. Only these exact paths are served (no directory access).
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/dashboard': ['index.html', 'text/html; charset=utf-8'],
  '/assets/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/assets/selfcheck.js': ['selfcheck.js', 'text/javascript; charset=utf-8'],
  '/assets/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const RECENT_MAX = 100;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Idempotency-Key, X-Request-Id',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers':
    'X-Request-Id, X-Response-Time, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After, Idempotent-Replayed',
  'Access-Control-Max-Age': '600',
};

function createApp(overrides = {}) {
  const config = buildConfig(overrides);
  const now = config.now;
  const startedAt = now();

  const keys = new Map(Object.entries(config.apiKeys));
  const metrics = new Metrics({ now });
  const limiter = new RateLimiter({ ...config.rateLimit, now });
  const store = new TicketStore({ dataDir: config.dataDir, persist: config.persist });
  const idempotency = new IdempotencyStore({
    dataDir: config.dataDir, persist: config.persist, ttlMs: config.idempotencyTtlMs, now,
  });
  const breaker = new CircuitBreaker({ ...config.breaker, now });
  const notifier = new Notifier({
    breaker,
    latencyMs: config.notifier.latencyMs,
    onDeliveredFromQueue: (id) => {
      const at = iso(now());
      store.update(
        id,
        { notification: 'sent', updatedAt: at },
        { at, event: 'notification_delivered_from_queue', actor: 'system', details: {} },
      );
    },
  });
  const registry = buildRegistry();
  const router = new Router(registry);

  const log = (obj) => { if (config.logRequests) console.log(JSON.stringify(obj)); };
  const recentRequests = []; // newest first, shown by GET /admin/logs

  async function handle(req, res) {
    const t0 = process.hrtime.bigint();
    const latencyMs = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const requestId = resolveRequestId(req.headers['x-request-id']);
    let extraHeaders = {}; // rate-limit headers, added once known
    let role = null;

    function reply(status, payload, headers = {}) {
      if (res.headersSent) return;
      const h = {
        'X-Request-Id': requestId,
        'X-Response-Time': `${latencyMs().toFixed(2)}ms`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...(config.cors ? CORS : {}),
        ...extraHeaders,
        ...headers,
      };
      if (status === 204 || payload === undefined) {
        res.writeHead(status, h);
        res.end();
        return;
      }
      const body = JSON.stringify(payload);
      res.writeHead(status, { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    }

    function replyRaw(status, buffer, contentType, headers = {}) {
      if (res.headersSent) return;
      res.writeHead(status, {
        'X-Request-Id': requestId,
        'X-Response-Time': `${latencyMs().toFixed(2)}ms`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        ...extraHeaders,
        ...headers,
      });
      res.end(buffer);
    }

    function replyError(err, headers) {
      const { status, body } = toErrorResponse(err, requestId, console.error);
      reply(status, body, headers);
    }

    let target = '-';
    res.on('finish', () => {
      const ms = latencyMs();
      metrics.record({ status: res.statusCode, latencyMs: ms });
      const latency = Math.round(ms * 100) / 100;
      log({ ts: iso(now()), requestId, method: req.method, path: target, status: res.statusCode, latencyMs: latency, role });
      const isApi = target.startsWith(API_PREFIX);
      const isPolling = req.method === 'GET' && (target === `${API_PREFIX}/health` || target === `${API_PREFIX}/admin/logs`);
      if (isApi && !isPolling && req.method !== 'OPTIONS') {
        recentRequests.unshift({ at: iso(now()), requestId, method: req.method, path: target, status: res.statusCode, latencyMs: latency, role });
        if (recentRequests.length > RECENT_MAX) recentRequests.pop();
      }
    });

    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw new ApiError(400, 'BAD_REQUEST', 'Malformed URL');
      }
      target = url.pathname.slice(0, 200);

      // CORS preflight: answered before rate limiting and authentication.
      if (req.method === 'OPTIONS') return reply(204, undefined);

      // 2. RATE LIMIT (per API key, or per IP for unknown callers)
      const presented = req.headers['x-api-key'];
      const known = typeof presented === 'string' && keys.has(presented);
      const identity = known ? `key:${presented}` : `ip:${req.socket.remoteAddress}`;
      const rl = limiter.check(identity);
      extraHeaders = { 'X-RateLimit-Limit': String(rl.limit), 'X-RateLimit-Remaining': String(rl.remaining) };
      if (!rl.allowed) {
        metrics.recordRateLimited();
        extraHeaders['Retry-After'] = String(rl.retryAfterSec);
        throw new ApiError(429, 'RATE_LIMITED', `Too many requests. Retry in ${rl.retryAfterSec} second(s)`);
      }

      let path = url.pathname;
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

      // Dashboard (static files, exact paths only)
      if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC, path)) {
        const [file, type] = STATIC[path];
        const buffer = await fs.readFile(nodePath.join(PUBLIC_DIR, file));
        return replyRaw(200, buffer, type, type.startsWith('text/html') ? { 'Content-Security-Policy': PAGE_CSP } : {});
      }

      // Route lookup
      const matched = path === API_PREFIX || path.startsWith(API_PREFIX + '/')
        ? router.match(req.method, path.slice(API_PREFIX.length) || '/')
        : null;
      if (!matched) throw new ApiError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${target}`);
      const { entry, params } = matched;

      // 3. AUTHN (who are you?) and 4. AUTHZ (what can you do?)
      let apiKey = null;
      if (entry.roles !== 'public') {
        const who = authenticate(req, keys);
        if (!who) throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key (send it in the x-api-key header)');
        role = who.role;
        apiKey = who.key;
        if (!authorize(role, entry.roles)) {
          throw new ApiError(403, 'FORBIDDEN', `Role "${role}" is not allowed to ${req.method} ${API_PREFIX}${entry.path}`);
        }
      }

      // 5. GATEKEEPER, syntactic part for the body: size and JSON syntax
      let body;
      if (req.method === 'POST' || req.method === 'PUT') {
        const { raw, tooLarge } = await readBody(req, config.bodyLimitBytes);
        if (tooLarge) {
          throw new ApiError(400, 'PAYLOAD_TOO_LARGE', `Request body must not exceed ${config.bodyLimitBytes} bytes`);
        }
        if (raw.trim() !== '') {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
          }
        }
      }

      // Query string -> plain object (first value wins; repeated keys are reported to the validator)
      const query = Object.create(null);
      const repeated = [];
      for (const [k, v] of url.searchParams) {
        if (k in query) { if (!repeated.includes(k)) repeated.push(k); } else query[k] = v;
      }

      const ctx = {
        req, params, query, repeated, body, role, apiKey, requestId, now, config, startedAt,
        store, idempotency, notifier, metrics, recentRequests,
      };
      const result = await entry.handler(ctx);

      // 10. RESPOND
      const payload = result.status === 204 ? undefined : { data: result.data, meta: { ...(result.meta || {}), requestId } };
      reply(result.status, payload, result.headers);
    } catch (err) {
      replyError(err);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[fatal in handler]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }));
      }
    });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    config, server, store, notifier, breaker, metrics, idempotency, registry, recentRequests,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}

module.exports = { createApp };
