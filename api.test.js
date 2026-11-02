'use strict';
// Acceptance tests 1-15 from the project spec, plus extra edge cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeClock, KEYS, ticketBody } = require('./helpers');

async function withApp(overrides, fn) {
  const ctx = await startApp(overrides);
  try { await fn(ctx); } finally { await ctx.close(); }
}

// ---------------------------------------------------------------- 1
test('1. POST valid critical ticket with agent key -> 201, score 90, critical, SLA +1h', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now }, async ({ call }) => {
    const r = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    assert.equal(r.status, 201);
    const t = r.json.data;
    assert.match(t.id, /^tkt_\d{4}$/);
    assert.equal(t.score, 90);
    assert.equal(t.priority, 'critical');
    assert.equal(t.status, 'open');
    assert.equal(t.notification, 'sent');
    assert.equal(Date.parse(t.slaDueAt) - Date.parse(t.createdAt), 3600 * 1000);
    assert.ok(r.json.meta.requestId);
    assert.equal(r.headers.get('x-request-id'), r.json.meta.requestId);
    assert.match(r.headers.get('x-response-time'), /ms$/);
  });
});

// ---------------------------------------------------------------- 2
test('2. POST with a 2-character title -> 400 with a field-level message', async () => {
  await withApp({}, async ({ call }) => {
    const r = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ title: 'ab' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION_FAILED');
    assert.ok(r.json.error.details.includes('title must be 5-100 characters'));
    assert.ok(r.json.requestId);
  });
});

test('2b. Gatekeeper: reports every problem at once (syntactic and semantic)', async () => {
  await withApp({}, async ({ call }) => {
    const r = await call('POST', '/tickets', {
      key: KEYS.agent,
      body: { email: 'not-an-email', title: 'Same words here', description: 'Same words here', category: 'weird', affectedUsers: 0, extra: 1 },
    });
    assert.equal(r.status, 400);
    const d = r.json.error.details;
    assert.ok(d.some((m) => m.includes('unknown field "extra"')));
    assert.ok(d.includes('email must be a valid email address'));
    assert.ok(d.some((m) => m.startsWith('category must be one of')));
    assert.ok(d.includes('affectedUsers must be an integer from 1 to 100000'));
    assert.ok(d.includes('description must not simply repeat the title'));
  });
});

test('2c. semantic rules: security needs affectedUsers; description must not repeat title', async () => {
  await withApp({}, async ({ call }) => {
    const a = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ category: 'security', affectedUsers: undefined }) });
    assert.equal(a.status, 400);
    assert.ok(a.json.error.details.includes('affectedUsers is required for security tickets'));
    const b = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ title: 'Login page broken', description: 'login page broken' }) });
    assert.equal(b.status, 400);
    assert.ok(b.json.error.details.includes('description must not simply repeat the title'));
  });
});

test('2d. rejects non-integer, string and huge affectedUsers; empty body; array body', async () => {
  await withApp({}, async ({ call }) => {
    for (const bad of [1.5, '10', 100001, -3, null]) {
      const r = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ affectedUsers: bad }) });
      assert.equal(r.status, 400, `affectedUsers=${JSON.stringify(bad)}`);
    }
    const empty = await call('POST', '/tickets', { key: KEYS.agent });
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.json.error.details, ['body must be a JSON object']);
    const arr = await call('POST', '/tickets', { key: KEYS.agent, body: [1, 2] });
    assert.equal(arr.status, 400);
  });
});

test('2e. HTML tags are stripped from title and description', async () => {
  await withApp({}, async ({ call }) => {
    const r = await call('POST', '/tickets', {
      key: KEYS.agent,
      body: ticketBody({ category: 'bug', affectedUsers: 5, title: '<b>Broken</b> <script>x()</script>button', description: 'The <i>save</i> button does nothing at all' }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.title, 'Broken x()button');
    assert.equal(r.json.data.description, 'The save button does nothing at all');
  });
});

// ---------------------------------------------------------------- 3
test('3. POST with invalid JSON syntax -> 400 INVALID_JSON, no crash', async () => {
  await withApp({}, async ({ call }) => {
    const r = await call('POST', '/tickets', { key: KEYS.agent, raw: '{"email": ', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'INVALID_JSON');
    const ok = await call('GET', '/health');
    assert.equal(ok.status, 200); // server still alive
  });
});

test('3b. body larger than 10 KB -> 400 PAYLOAD_TOO_LARGE', async () => {
  await withApp({}, async ({ call }) => {
    const r = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ description: 'x'.repeat(11 * 1024) }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

// ---------------------------------------------------------------- 4
test('4. POST with no or wrong x-api-key -> 401', async () => {
  await withApp({}, async ({ call }) => {
    const none = await call('POST', '/tickets', { body: ticketBody() });
    assert.equal(none.status, 401);
    assert.equal(none.json.error.code, 'UNAUTHORIZED');
    const wrong = await call('GET', '/tickets', { key: 'nope' });
    assert.equal(wrong.status, 401);
    const proto = await call('GET', '/tickets', { key: '__proto__' });
    assert.equal(proto.status, 401);
  });
});

// ---------------------------------------------------------------- 5 & 6
test('5. DELETE with an agent key -> 403', async () => {
  await withApp({}, async ({ call }) => {
    const c = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    const r = await call('DELETE', `/tickets/${c.json.data.id}`, { key: KEYS.agent });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'FORBIDDEN');
  });
});

test('6. DELETE with an admin key -> 204; later GET of that id -> 404', async () => {
  await withApp({}, async ({ call }) => {
    const c = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    const id = c.json.data.id;
    const del = await call('DELETE', `/tickets/${id}`, { key: KEYS.admin });
    assert.equal(del.status, 204);
    assert.equal(del.text, '');
    const get = await call('GET', `/tickets/${id}`, { key: KEYS.viewer });
    assert.equal(get.status, 404);
    assert.equal(get.json.error.code, 'TICKET_NOT_FOUND');
    const again = await call('DELETE', `/tickets/${id}`, { key: KEYS.admin });
    assert.equal(again.status, 404);
    const hist = await call('GET', `/tickets/${id}/history`, { key: KEYS.viewer });
    assert.equal(hist.status, 404);
  });
});

test('5b. role matrix: viewer is read-only; agent cannot see metrics or the simulator', async () => {
  await withApp({}, async ({ call }) => {
    assert.equal((await call('POST', '/tickets', { key: KEYS.viewer, body: ticketBody() })).status, 403);
    assert.equal((await call('GET', '/tickets', { key: KEYS.viewer })).status, 200);
    assert.equal((await call('GET', '/stats', { key: KEYS.viewer })).status, 200);
    assert.equal((await call('GET', '/metrics', { key: KEYS.agent })).status, 403);
    assert.equal((await call('PUT', '/admin/notifier', { key: KEYS.agent, body: { mode: 'failing' } })).status, 403);
    assert.equal((await call('PUT', '/tickets/tkt_0001/status', { key: KEYS.viewer, body: { status: 'resolved' } })).status, 403);
  });
});

// ---------------------------------------------------------------- 7
test('7. PUT status resolved, then PUT status open -> 200 then 400 (no reopening)', async () => {
  await withApp({}, async ({ call }) => {
    const c = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    const id = c.json.data.id;
    const first = await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'resolved' } });
    assert.equal(first.status, 200);
    assert.equal(first.json.data.status, 'resolved');
    const second = await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'open' } });
    assert.equal(second.status, 400);
    assert.equal(second.json.error.code, 'INVALID_STATUS_TRANSITION');
    const same = await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'resolved' } });
    assert.equal(same.status, 400);
  });
});

test('7b. status lifecycle open -> in_progress -> resolved is recorded in history; bad input is rejected', async () => {
  await withApp({}, async ({ call }) => {
    const c = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    const id = c.json.data.id;
    assert.equal((await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'in_progress' } })).status, 200);
    assert.equal((await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'open' } })).status, 400);
    assert.equal((await call('PUT', `/tickets/${id}/status`, { key: KEYS.admin, body: { status: 'resolved' } })).status, 200);
    assert.equal((await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'closed' } })).status, 400);
    assert.equal((await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'resolved', x: 1 } })).status, 400);
    assert.equal((await call('PUT', '/tickets/tkt_9999/status', { key: KEYS.agent, body: { status: 'resolved' } })).status, 404);

    const h = await call('GET', `/tickets/${id}/history`, { key: KEYS.viewer });
    assert.equal(h.status, 200);
    const events = h.json.data.map((e) => e.event);
    assert.deepEqual(events, ['created', 'notification_sent', 'status_changed', 'status_changed']);
    assert.deepEqual(h.json.data[2].details, { from: 'open', to: 'in_progress' });
    assert.equal(h.json.data[3].actor, 'admin');
  });
});

// ---------------------------------------------------------------- 8
test('8. Same Idempotency-Key twice -> one ticket stored, replay flagged', async () => {
  await withApp({}, async ({ call }) => {
    const headers = { 'Idempotency-Key': 'order-001' };
    const a = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers });
    const b = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.headers.get('idempotent-replayed'), null);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal(a.json.data.id, b.json.data.id);
    const list = await call('GET', '/tickets', { key: KEYS.viewer });
    assert.equal(list.json.meta.total, 1);
  });
});

test('8b. Idempotency-Key reused with a different body -> 400; invalid key format -> 400; keys are per API key', async () => {
  await withApp({}, async ({ call }) => {
    const headers = { 'Idempotency-Key': 'order-002' };
    await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers });
    const diff = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ title: 'A completely different title' }), headers });
    assert.equal(diff.status, 400);
    assert.equal(diff.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
    const badKey = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers: { 'Idempotency-Key': 'bad key!' } });
    assert.equal(badKey.status, 400);
    // the same key string used by a different caller is a different request: it hits the duplicate rule, not a replay
    const other = await call('POST', '/tickets', { key: KEYS.admin, body: ticketBody(), headers });
    assert.equal(other.status, 400);
    assert.equal(other.json.error.code, 'DUPLICATE_TICKET');
  });
});

test('8c. two simultaneous requests with the same key create exactly one ticket', async () => {
  await withApp({ notifier: { latencyMs: 40 } }, async ({ call }) => {
    const headers = { 'Idempotency-Key': 'race-1' };
    const [a, b] = await Promise.all([
      call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers }),
      call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers }),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal((await call('GET', '/tickets', { key: KEYS.viewer })).json.meta.total, 1);
  });
});

test('8d. an Idempotency-Key expires after 24 hours', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now, rateLimit: { max: 1000 } }, async ({ call }) => {
    const headers = { 'Idempotency-Key': 'ttl-1' };
    const a = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers });
    clock.advance(24 * 3600 * 1000 + 1);
    const b = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers });
    assert.equal(b.status, 201);
    assert.equal(b.headers.get('idempotent-replayed'), null);
    assert.notEqual(a.json.data.id, b.json.data.id);
  });
});

// ---------------------------------------------------------------- 9
test('9. same body twice within 10 minutes (no key) -> second is 400 DUPLICATE_TICKET', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now }, async ({ call }) => {
    const a = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    assert.equal(a.status, 201);
    const b = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ title: '  CHECKOUT page   is DOWN ' }) });
    assert.equal(b.status, 400);
    assert.equal(b.json.error.code, 'DUPLICATE_TICKET');
    assert.ok(b.json.error.message.includes(a.json.data.id));
    // different email is not a duplicate
    const c = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ email: 'ben@example.com' }) });
    assert.equal(c.status, 201);
    // after the window the same request is allowed again
    clock.advance(10 * 60 * 1000);
    const d = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    assert.equal(d.status, 201);
  });
});

test('9b. a resolved ticket does not block a new identical one', async () => {
  await withApp({}, async ({ call }) => {
    const a = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    await call('PUT', `/tickets/${a.json.data.id}/status`, { key: KEYS.agent, body: { status: 'resolved' } });
    const b = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    assert.equal(b.status, 201);
  });
});

// ---------------------------------------------------------------- 10
test('10. the 101st request in one minute -> 429 with Retry-After; window resets', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now }, async ({ call }) => {
    for (let i = 1; i <= 100; i++) {
      const r = await call('GET', '/stats', { key: KEYS.viewer });
      assert.equal(r.status, 200, `request ${i}`);
      if (i === 1) assert.equal(r.headers.get('x-ratelimit-remaining'), '99');
    }
    const over = await call('GET', '/stats', { key: KEYS.viewer });
    assert.equal(over.status, 429);
    assert.equal(over.json.error.code, 'RATE_LIMITED');
    assert.equal(over.headers.get('retry-after'), '60');
    assert.equal(over.headers.get('x-ratelimit-remaining'), '0');
    // another key is not affected
    assert.equal((await call('GET', '/stats', { key: KEYS.agent })).status, 200);
    clock.advance(60000);
    assert.equal((await call('GET', '/stats', { key: KEYS.viewer })).status, 200);
  });
});

// ---------------------------------------------------------------- 11, 12, 13
test('11-13. failure simulator: breaker opens, fails fast and queues, then recovers and flushes', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now, rateLimit: { max: 1000 } }, async ({ call, app }) => {
    const mk = (n) => ticketBody({ title: `Payment gateway down ${n}`, description: 'Customers cannot pay at all, urgent', affectedUsers: 50 });

    const set = await call('PUT', '/admin/notifier', { key: KEYS.admin, body: { mode: 'failing' } });
    assert.equal(set.status, 200);
    assert.equal(set.json.data.mode, 'failing');

    // 11. three critical tickets while failing: all 201, breaker OPEN
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      const r = await call('POST', '/tickets', { key: KEYS.agent, body: mk(i) });
      assert.equal(r.status, 201);
      assert.equal(r.json.data.priority, 'critical');
      assert.equal(r.json.data.notification, 'queued');
      ids.push(r.json.data.id);
    }
    assert.equal((await call('GET', '/health')).json.data.circuitBreaker.state, 'OPEN');

    // 12. breaker OPEN: still 201, notification queued, and the notifier is NOT called (fail fast)
    const attempts = app.notifier.attempts;
    const fast = await call('POST', '/tickets', { key: KEYS.agent, body: mk(4) });
    assert.equal(fast.status, 201);
    assert.equal(fast.json.data.notification, 'queued');
    assert.equal(app.notifier.attempts, attempts);
    ids.push(fast.json.data.id);

    const m1 = await call('GET', '/metrics', { key: KEYS.admin });
    assert.deepEqual(m1.json.data.circuitBreaker, { state: 'OPEN', consecutiveFailures: 3, queued: 4 });

    // 13. healthy again + 20 seconds -> HALF_OPEN trial succeeds -> CLOSED, queue flushes
    await call('PUT', '/admin/notifier', { key: KEYS.admin, body: { mode: 'healthy' } });
    clock.advance(20000);
    assert.equal((await call('GET', '/health')).json.data.circuitBreaker.state, 'HALF_OPEN');
    const trial = await call('POST', '/tickets', { key: KEYS.agent, body: mk(5) });
    assert.equal(trial.status, 201);
    assert.equal(trial.json.data.notification, 'sent');
    await app.notifier.whenIdle();
    assert.equal((await call('GET', '/health')).json.data.circuitBreaker.state, 'CLOSED');
    for (const id of ids) {
      const t = await call('GET', `/tickets/${id}`, { key: KEYS.viewer });
      assert.equal(t.json.data.notification, 'sent', id);
      const h = await call('GET', `/tickets/${id}/history`, { key: KEYS.viewer });
      assert.equal(h.json.data.at(-1).event, 'notification_delivered_from_queue');
    }
    const m2 = await call('GET', '/metrics', { key: KEYS.admin });
    assert.equal(m2.json.data.circuitBreaker.queued, 0);
  });
});

test('11b. low and medium tickets never touch the notifier', async () => {
  await withApp({}, async ({ call, app }) => {
    const r = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ category: 'general', title: 'Question about invoices', description: 'How do I download my invoices?', affectedUsers: 1 }) });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.priority, 'low');
    assert.equal(r.json.data.notification, 'not_required');
    assert.equal(app.notifier.attempts, 0);
  });
});

test('11c. PUT /admin/notifier validates its body', async () => {
  await withApp({}, async ({ call }) => {
    assert.equal((await call('PUT', '/admin/notifier', { key: KEYS.admin, body: { mode: 'exploding' } })).status, 400);
    assert.equal((await call('PUT', '/admin/notifier', { key: KEYS.admin, body: {} })).status, 400);
    assert.equal((await call('PUT', '/admin/notifier', { key: KEYS.admin, body: { mode: 'healthy', x: 1 } })).status, 400);
  });
});

// ---------------------------------------------------------------- 14
test('14. GET /metrics (admin) reflects real traffic', async () => {
  await withApp({}, async ({ call }) => {
    await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() }); // 201
    await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ title: 'x' }) }); // 400
    await call('GET', '/tickets'); // 401
    const r = await call('GET', '/metrics', { key: KEYS.admin });
    assert.equal(r.status, 200);
    const m = r.json.data;
    assert.equal(m.totalRequests, 3);
    assert.deepEqual(m.statusBreakdown, { '2xx': 1, '4xx': 2, '5xx': 0 });
    assert.equal(m.availabilityPercent, 100);
    assert.equal(m.requestsPerMinute, 3);
    assert.ok(m.avgLatencyMs >= 0 && m.p95LatencyMs >= m.avgLatencyMs * 0); // numbers present
    assert.equal(typeof m.uptimeSeconds, 'number');
    assert.equal(m.circuitBreaker.state, 'CLOSED');
  });
});

// ---------------------------------------------------------------- 15
test('15. GET /docs lists every registered route with a runnable curl example', async () => {
  await withApp({}, async ({ call, app }) => {
    const r = await call('GET', '/docs');
    assert.equal(r.status, 200);
    const eps = r.json.data.endpoints;
    assert.equal(eps.length, app.registry.length);
    for (const e of app.registry) {
      const doc = eps.find((x) => x.method === e.method && x.path === `/api/v1${e.path}`);
      assert.ok(doc, `${e.method} ${e.path} documented`);
      assert.match(doc.exampleCurl, /^curl -s -X /);
      assert.ok(doc.summary);
    }
    const create = eps.find((x) => x.method === 'POST' && x.path === '/api/v1/tickets');
    assert.match(create.exampleCurl, /x-api-key: \$AGENT_KEY/);
    assert.match(create.exampleCurl, /Idempotency-Key/);
  });
});

// ---------------------------------------------------------------- extras
test('list: filters, sorting, pagination and query validation', async () => {
  await withApp({ rateLimit: { max: 1000 } }, async ({ call }) => {
    const mk = (title, category, affectedUsers, desc = 'Some details about the problem here') =>
      call('POST', '/tickets', { key: KEYS.agent, body: { email: 'a@b.co', title, description: desc, category, affectedUsers } });
    await mk('First general ticket', 'general', 1); // 5 low
    await mk('Billing mismatch seen', 'billing', 20); // 30 medium
    await mk('Bug in export screen', 'bug', 3); // 15 low
    await mk('Server is down now', 'outage', 500); // 40+15+20 = 75 high

    const all = await call('GET', '/tickets', { key: KEYS.viewer });
    assert.equal(all.json.meta.total, 4);
    assert.equal(all.json.data[0].title, 'Server is down now'); // default -createdAt

    const bySc = await call('GET', '/tickets?sort=-score', { key: KEYS.viewer });
    assert.deepEqual(bySc.json.data.map((t) => t.score), [75, 30, 15, 5]);
    const asc = await call('GET', '/tickets?sort=score&limit=2', { key: KEYS.viewer });
    assert.deepEqual(asc.json.data.map((t) => t.score), [5, 15]);
    assert.deepEqual([asc.json.meta.page, asc.json.meta.limit, asc.json.meta.total, asc.json.meta.totalPages], [1, 2, 4, 2]);
    const p2 = await call('GET', '/tickets?sort=score&limit=2&page=2', { key: KEYS.viewer });
    assert.deepEqual(p2.json.data.map((t) => t.score), [30, 75]);
    const beyond = await call('GET', '/tickets?page=9', { key: KEYS.viewer });
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.json.data, []);

    assert.equal((await call('GET', '/tickets?priority=low', { key: KEYS.viewer })).json.meta.total, 2);
    assert.equal((await call('GET', '/tickets?priority=high&category=outage', { key: KEYS.viewer })).json.meta.total, 1);
    assert.equal((await call('GET', '/tickets?status=resolved', { key: KEYS.viewer })).json.meta.total, 0);

    for (const q of ['page=0', 'page=abc', 'limit=51', 'limit=0', 'priority=urgent', 'status=done', 'category=x', 'sort=title', 'foo=1', 'page=1&page=2']) {
      const r = await call('GET', `/tickets?${q}`, { key: KEYS.viewer });
      assert.equal(r.status, 400, q);
      assert.equal(r.json.error.code, 'VALIDATION_FAILED', q);
    }
  });
});

test('stats: counts by priority, status, category and overdue SLA tickets', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now }, async ({ call }) => {
    await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() }); // critical, SLA 1h
    const s1 = await call('GET', '/stats', { key: KEYS.viewer });
    assert.equal(s1.json.data.total, 1);
    assert.equal(s1.json.data.byPriority.critical, 1);
    assert.equal(s1.json.data.byStatus.open, 1);
    assert.equal(s1.json.data.byCategory.outage, 1);
    assert.equal(s1.json.data.overdue, 0);
    clock.advance(3600 * 1000 + 1);
    assert.equal((await call('GET', '/stats', { key: KEYS.viewer })).json.data.overdue, 1);
  });
});

test('health is public and reports the integrity check', async () => {
  await withApp({}, async ({ call }) => {
    const r = await call('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, 'ok');
    assert.deepEqual(r.json.data.dataStore, { ok: true, mode: 'memory' });
    assert.equal(r.json.data.circuitBreaker.state, 'CLOSED');
  });
});

test('unknown routes and methods -> 404 JSON; trailing slash is tolerated', async () => {
  await withApp({}, async ({ call, base }) => {
    const r = await call('GET', '/nope', { key: KEYS.admin });
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'ROUTE_NOT_FOUND');
    assert.equal((await call('PATCH', '/tickets/tkt_0001', { key: KEYS.admin })).status, 404);
    assert.equal((await call('GET', '/health/')).status, 200);
    const notAPage = await fetch(base.replace('/api/v1', '/nope-page'));
    assert.equal(notAPage.status, 404);
    const bad = await fetch(base + '/tickets/%E0%A4%A', { headers: { 'x-api-key': KEYS.viewer } });
    assert.equal(bad.status, 404);
  });
});

test('global error handler: an unexpected crash becomes a clean 500 with no stack trace', async () => {
  await withApp({}, async ({ call, app }) => {
    const original = app.store.create;
    app.store.create = () => { throw new Error('disk exploded at /secret/path'); };
    const origErr = console.error;
    console.error = () => {};
    let r;
    try { r = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() }); } finally { console.error = origErr; }
    assert.equal(r.status, 500);
    assert.equal(r.json.error.code, 'INTERNAL_ERROR');
    assert.ok(r.json.requestId);
    assert.ok(!r.text.includes('exploded'));
    assert.ok(!r.text.includes('/secret/path'));
    assert.ok(!r.text.includes('at '));
    app.store.create = original;
    // an idempotency key must be released after a failure so the client can retry
    const headers = { 'Idempotency-Key': 'retry-after-500' };
    app.store.create = () => { throw new Error('boom'); };
    console.error = () => {};
    try { await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers }); } finally { console.error = origErr; }
    app.store.create = original;
    const retry = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers });
    assert.equal(retry.status, 201);
    const m = await call('GET', '/metrics', { key: KEYS.admin });
    assert.equal(m.json.data.statusBreakdown['5xx'], 2);
    assert.ok(m.json.data.availabilityPercent < 100);
  });
});

test('client-supplied X-Request-Id is reused only when it is safe', async () => {
  await withApp({}, async ({ call }) => {
    const good = await call('GET', '/health', { headers: { 'X-Request-Id': 'trace-abc_123' } });
    assert.equal(good.headers.get('x-request-id'), 'trace-abc_123');
    const bad = await call('GET', '/health', { headers: { 'X-Request-Id': 'bad id with spaces <script>' } });
    assert.match(bad.headers.get('x-request-id'), /^req_[0-9a-f]{8}$/);
  });
});

test('CORS: preflight is answered with 204 and does not need a key; responses carry CORS headers', async () => {
  await withApp({}, async ({ base, call }) => {
    const pre = await fetch(base + '/tickets', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5500', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /x-api-key/i);
    const r = await call('GET', '/health');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('persistence: tickets, history, id counter and idempotency survive a restart', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
  try {
    let id;
    await withApp({ persist: true, dataDir: dir }, async ({ call }) => {
      const a = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers: { 'Idempotency-Key': 'persist-1' } });
      id = a.json.data.id;
      await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'in_progress' } });
      assert.deepEqual((await call('GET', '/health')).json.data.dataStore, { ok: true, mode: 'file' });
    });
    assert.ok(fs.existsSync(path.join(dir, 'tickets.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'tickets.json.tmp')));

    await withApp({ persist: true, dataDir: dir }, async ({ call }) => {
      const got = await call('GET', `/tickets/${id}`, { key: KEYS.viewer });
      assert.equal(got.status, 200);
      assert.equal(got.json.data.status, 'in_progress');
      const hist = await call('GET', `/tickets/${id}/history`, { key: KEYS.viewer });
      assert.equal(hist.json.data.length, 3); // created, notification_sent, status_changed
      const replay = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(), headers: { 'Idempotency-Key': 'persist-1' } });
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      assert.equal(replay.json.data.id, id);
      const next = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody({ title: 'Another distinct problem' }) });
      assert.equal(next.json.data.id, 'tkt_0002');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: a corrupt data file is set aside and the server still starts', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'tickets.json'), '{ this is not json');
    const origErr = console.error;
    console.error = () => {};
    try {
      await withApp({ persist: true, dataDir: dir }, async ({ call }) => {
        assert.equal((await call('GET', '/health')).status, 200);
        assert.equal((await call('GET', '/tickets', { key: KEYS.viewer })).json.meta.total, 0);
      });
    } finally { console.error = origErr; }
    assert.ok(fs.existsSync(path.join(dir, 'tickets.json.corrupt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
