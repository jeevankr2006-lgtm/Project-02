'use strict';
// Version 2 features: comments, assignee, priority override, search/overdue/date filters,
// admin notifier + logs, API index, dashboard files, and the shared self-check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp, makeClock, KEYS, ticketBody } = require('./helpers');
const SelfCheck = require('../public/selfcheck.js');

async function withApp(overrides, fn) {
  const ctx = await startApp({ rateLimit: { max: 1000 }, ...overrides });
  try { await fn(ctx); } finally { await ctx.close(); }
}
const make = async (call, over = {}) => (await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(over) })).json.data;
const low = (n) => ({ category: 'general', affectedUsers: 1, title: `General question number ${n}`, description: `Some details about question ${n} here` });

// ------------------------------------------------------------------ comments
test('comments: create, list, history, validation, permissions, cascade delete', async () => {
  await withApp({}, async ({ call }) => {
    const t = await make(call);
    const post = await call('POST', `/tickets/${t.id}/comments`, { key: KEYS.agent, body: { text: '  Hello <b>team</b>  ' } });
    assert.equal(post.status, 201);
    assert.equal(post.json.data.text, 'Hello team');
    assert.match(post.json.data.id, /^cmt_\d{4}$/);
    assert.equal(post.json.data.author, 'agent');
    assert.equal(post.json.data.ticketId, t.id);
    const second = await call('POST', `/tickets/${t.id}/comments`, { key: KEYS.admin, body: { text: 'Second comment' } });
    assert.equal(second.status, 201);

    const list = await call('GET', `/tickets/${t.id}/comments`, { key: KEYS.viewer });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.data.map((c) => c.author), ['agent', 'admin']);

    assert.equal((await call('POST', `/tickets/${t.id}/comments`, { key: KEYS.viewer, body: { text: 'nope' } })).status, 403);
    for (const bad of [{ text: '' }, { text: 'x'.repeat(501) }, {}, { text: 'a', x: 1 }, { text: 5 }, { text: '<b></b>' }]) {
      const r = await call('POST', `/tickets/${t.id}/comments`, { key: KEYS.agent, body: bad });
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
    }
    assert.equal((await call('POST', '/tickets/tkt_9999/comments', { key: KEYS.agent, body: { text: 'hi' } })).status, 404);
    assert.equal((await call('GET', '/tickets/tkt_9999/comments', { key: KEYS.viewer })).status, 404);

    const hist = await call('GET', `/tickets/${t.id}/history`, { key: KEYS.viewer });
    assert.equal(hist.json.data.filter((e) => e.event === 'comment_added').length, 2);

    await call('DELETE', `/tickets/${t.id}`, { key: KEYS.admin });
    assert.equal((await call('GET', `/tickets/${t.id}/comments`, { key: KEYS.viewer })).status, 404);
  });
});

// ------------------------------------------------------------------ assignee
test('assignee: set, idempotent PUT, unassign, validation, permissions, filter', async () => {
  await withApp({}, async ({ call }) => {
    const a = await make(call);
    const b = await make(call, { title: 'Second outage ticket', email: 'ben@example.com' });
    const set = await call('PUT', `/tickets/${a.id}/assignee`, { key: KEYS.agent, body: { assignee: 'Ravi Kumar' } });
    assert.equal(set.status, 200);
    assert.equal(set.json.data.assignee, 'Ravi Kumar');
    const again = await call('PUT', `/tickets/${a.id}/assignee`, { key: KEYS.agent, body: { assignee: 'Ravi Kumar' } });
    assert.equal(again.status, 200); // PUT is idempotent

    const byName = await call('GET', '/tickets?assignee=ravi%20kumar', { key: KEYS.viewer });
    assert.deepEqual(byName.json.data.map((t) => t.id), [a.id]);
    const none = await call('GET', '/tickets?assignee=unassigned', { key: KEYS.viewer });
    assert.deepEqual(none.json.data.map((t) => t.id), [b.id]);

    const un = await call('PUT', `/tickets/${a.id}/assignee`, { key: KEYS.agent, body: { assignee: null } });
    assert.equal(un.json.data.assignee, null);
    const events = (await call('GET', `/tickets/${a.id}/history`, { key: KEYS.viewer })).json.data.filter((e) => e.event === 'assignee_changed');
    assert.equal(events.length, 2); // the repeated PUT did not add an entry
    assert.deepEqual(events[0].details, { from: null, to: 'Ravi Kumar' });

    for (const bad of [{}, { assignee: 'a' }, { assignee: 123 }, { assignee: 'x'.repeat(51) }, { assignee: 'Ok Name', x: 1 }]) {
      assert.equal((await call('PUT', `/tickets/${a.id}/assignee`, { key: KEYS.agent, body: bad })).status, 400);
    }
    assert.equal((await call('PUT', `/tickets/${a.id}/assignee`, { key: KEYS.viewer, body: { assignee: 'Someone' } })).status, 403);
    assert.equal((await call('PUT', '/tickets/tkt_9999/assignee', { key: KEYS.agent, body: { assignee: 'Someone' } })).status, 404);
  });
});

// ------------------------------------------------------------------ priority override
test('priority override: admin only, needs a reason, restarts the SLA clock, blocked when resolved', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now }, async ({ call }) => {
    const t = await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(low(1)) });
    const id = t.json.data.id;
    assert.equal(t.json.data.priority, 'low');
    assert.equal(t.json.data.priorityOverridden, false);

    clock.advance(5 * 60 * 1000);
    const over = await call('PUT', `/tickets/${id}/priority`, { key: KEYS.admin, body: { priority: 'critical', reason: 'Customer is a VIP' } });
    assert.equal(over.status, 200);
    assert.equal(over.json.data.priority, 'critical');
    assert.equal(over.json.data.priorityOverridden, true);
    assert.equal(over.json.data.slaDueAt, new Date(clock.now() + 3600 * 1000).toISOString());
    assert.equal(over.json.data.score, t.json.data.score); // the score is untouched

    const ev = (await call('GET', `/tickets/${id}/history`, { key: KEYS.viewer })).json.data.find((e) => e.event === 'priority_overridden');
    assert.deepEqual(ev.details, { from: 'low', to: 'critical', reason: 'Customer is a VIP' });
    assert.equal(ev.actor, 'admin');

    assert.equal((await call('PUT', `/tickets/${id}/priority`, { key: KEYS.agent, body: { priority: 'low', reason: 'Trying as agent' } })).status, 403);
    for (const bad of [{ priority: 'high' }, { reason: 'No priority given' }, { priority: 'urgent', reason: 'Bad value here' }, { priority: 'high', reason: 'abc' }, { priority: 'high', reason: 'Fine reason', x: 1 }]) {
      assert.equal((await call('PUT', `/tickets/${id}/priority`, { key: KEYS.admin, body: bad })).status, 400, JSON.stringify(bad));
    }
    const same = await call('PUT', `/tickets/${id}/priority`, { key: KEYS.admin, body: { priority: 'critical', reason: 'Same value again' } });
    assert.equal(same.status, 400);
    assert.equal(same.json.error.code, 'NO_CHANGE');

    await call('PUT', `/tickets/${id}/status`, { key: KEYS.agent, body: { status: 'resolved' } });
    const resolved = await call('PUT', `/tickets/${id}/priority`, { key: KEYS.admin, body: { priority: 'low', reason: 'After resolving it' } });
    assert.equal(resolved.status, 400);
    assert.equal(resolved.json.error.code, 'TICKET_RESOLVED');
    assert.equal((await call('PUT', '/tickets/tkt_9999/priority', { key: KEYS.admin, body: { priority: 'low', reason: 'Does not exist' } })).status, 404);
  });
});

// ------------------------------------------------------------------ list filters
test('list: search, overdue and slaDueAt sorting', async () => {
  const clock = makeClock();
  await withApp({ now: clock.now }, async ({ call }) => {
    const L = (await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(low(1)) })).json.data; // low, SLA 72h
    const C = await make(call); // critical, SLA 1h
    clock.advance(2 * 3600 * 1000);

    const over = await call('GET', '/tickets?overdue=true', { key: KEYS.viewer });
    assert.deepEqual(over.json.data.map((t) => t.id), [C.id]);
    const notOver = await call('GET', '/tickets?overdue=false', { key: KEYS.viewer });
    assert.deepEqual(notOver.json.data.map((t) => t.id), [L.id]);

    await call('PUT', `/tickets/${C.id}/status`, { key: KEYS.agent, body: { status: 'resolved' } });
    assert.deepEqual((await call('GET', '/tickets?overdue=true', { key: KEYS.viewer })).json.data, []); // resolved is never overdue

    const asc = await call('GET', '/tickets?sort=slaDueAt', { key: KEYS.viewer });
    assert.deepEqual(asc.json.data.map((t) => t.id), [C.id, L.id]);
    const desc = await call('GET', '/tickets?sort=-slaDueAt', { key: KEYS.viewer });
    assert.deepEqual(desc.json.data.map((t) => t.id), [L.id, C.id]);

    assert.deepEqual((await call('GET', '/tickets?search=CHECKOUT', { key: KEYS.viewer })).json.data.map((t) => t.id), [C.id]);
    assert.deepEqual((await call('GET', '/tickets?search=question%201', { key: KEYS.viewer })).json.data.map((t) => t.id), [L.id]);
    assert.equal((await call('GET', '/tickets?search=nothing-matches-this', { key: KEYS.viewer })).json.meta.total, 0);
    for (const q of ['search=%20', 'overdue=maybe', 'search=' + 'x'.repeat(101)]) {
      assert.equal((await call('GET', `/tickets?${q}`, { key: KEYS.viewer })).status, 400, q);
    }
  });
});

test('list: createdFrom / createdTo (a date-only createdTo includes the whole day)', async () => {
  const clock = makeClock(Date.parse('2026-10-10T10:00:00.000Z'));
  await withApp({ now: clock.now }, async ({ call }) => {
    const X = (await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(low(1)) })).json.data;
    clock.set(Date.parse('2026-10-11T10:00:00.000Z'));
    const Y = (await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody(low(2)) })).json.data;
    const ids = async (q) => (await call('GET', `/tickets?${q}&sort=createdAt`, { key: KEYS.viewer })).json.data.map((t) => t.id);

    assert.deepEqual(await ids('createdFrom=2026-10-11'), [Y.id]);
    assert.deepEqual(await ids('createdTo=2026-10-10'), [X.id]);
    assert.deepEqual(await ids('createdFrom=2026-10-10&createdTo=2026-10-11'), [X.id, Y.id]);
    assert.deepEqual(await ids('createdFrom=2026-10-10T10:00:00Z&createdTo=2026-10-10T10:00:00Z'), [X.id]);
    assert.deepEqual(await ids('createdTo=2026-10-11T09:00:00Z'), [X.id]);
    assert.deepEqual(await ids('createdFrom=2026-10-12'), []);
    for (const q of ['createdFrom=yesterday', 'createdFrom=2026-13-45', 'createdTo=10/10/2026']) {
      const r = await call('GET', `/tickets?${q}`, { key: KEYS.viewer });
      assert.equal(r.status, 400, q);
    }
  });
});

// ------------------------------------------------------------------ admin notifier + logs
test('GET /admin/notifier shows mode, breaker and counters (admin only)', async () => {
  await withApp({}, async ({ call }) => {
    const a = await call('GET', '/admin/notifier', { key: KEYS.admin });
    assert.equal(a.status, 200);
    assert.deepEqual(a.json.data, { mode: 'healthy', circuitBreaker: { state: 'CLOSED', consecutiveFailures: 0, queued: 0 }, attempts: 0, delivered: 0 });
    await make(call);
    assert.equal((await call('GET', '/admin/notifier', { key: KEYS.admin })).json.data.delivered, 1);
    await call('PUT', '/admin/notifier', { key: KEYS.admin, body: { mode: 'failing' } });
    await make(call, { title: 'Another outage right now', email: 'ben@example.com' });
    const b = (await call('GET', '/admin/notifier', { key: KEYS.admin })).json.data;
    assert.equal(b.mode, 'failing');
    assert.equal(b.circuitBreaker.queued, 1);
    assert.equal(b.attempts, 2);
    assert.equal((await call('GET', '/admin/notifier', { key: KEYS.agent })).status, 403);
    assert.equal((await call('GET', '/admin/notifier')).status, 401);
  });
});

test('GET /admin/logs: newest first, limit, leaves out polling calls, admin only', async () => {
  await withApp({}, async ({ call }) => {
    await call('POST', '/tickets', { key: KEYS.agent, body: ticketBody() });
    await call('GET', '/tickets/tkt_9999', { key: KEYS.viewer });
    await call('GET', '/health');
    await call('GET', '/admin/logs', { key: KEYS.admin });

    const r = await call('GET', '/admin/logs', { key: KEYS.admin });
    assert.equal(r.status, 200);
    const rows = r.json.data;
    assert.deepEqual(rows.slice(0, 2).map((e) => [e.method, e.path, e.status, e.role]), [
      ['GET', '/api/v1/tickets/tkt_9999', 404, 'viewer'],
      ['POST', '/api/v1/tickets', 201, 'agent'],
    ]);
    assert.ok(rows.every((e) => !e.path.endsWith('/health') && !e.path.endsWith('/admin/logs')));
    assert.ok(rows[0].requestId && typeof rows[0].latencyMs === 'number' && rows[0].at);
    assert.equal((await call('GET', '/admin/logs?limit=1', { key: KEYS.admin })).json.data.length, 1);
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'foo=1']) {
      assert.equal((await call('GET', `/admin/logs?${q}`, { key: KEYS.admin })).status, 400, q);
    }
    assert.equal((await call('GET', '/admin/logs', { key: KEYS.agent })).status, 403);
  });
});

// ------------------------------------------------------------------ index + dashboard files
test('GET /api/v1/ is a public index; the dashboard and its assets are served; nothing else is', async () => {
  await withApp({}, async ({ call, base }) => {
    const idx = await call('GET', '/');
    assert.equal(idx.status, 200);
    assert.equal(idx.json.data.name, 'SynapseGate');
    assert.equal(idx.json.data.links.docs, '/api/v1/docs');

    const origin = base.replace('/api/v1', '');
    const page = await fetch(origin + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /SynapseGate/);
    assert.equal((await fetch(origin + '/dashboard')).status, 200);

    for (const [file, type] of [['dashboard.js', /javascript/], ['selfcheck.js', /javascript/], ['style.css', /text\/css/]]) {
      const r = await fetch(`${origin}/assets/${file}`);
      assert.equal(r.status, 200, file);
      assert.match(r.headers.get('content-type'), type);
    }
    for (const p of ['/package.json', '/src/app.js', '/assets/', '/assets/%2e%2e/package.json', '/data/tickets.json', '/assets/missing.js']) {
      assert.equal((await fetch(origin + p)).status, 404, p);
    }
    assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 404);
  });
});

// ------------------------------------------------------------------ persistence of new data
test('persistence: comments, assignee and priority override survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
  try {
    let id;
    await withApp({ persist: true, dataDir: dir }, async ({ call }) => {
      id = (await make(call)).id;
      await call('POST', `/tickets/${id}/comments`, { key: KEYS.agent, body: { text: 'Remember me' } });
      await call('PUT', `/tickets/${id}/assignee`, { key: KEYS.agent, body: { assignee: 'Ravi Kumar' } });
      await call('PUT', `/tickets/${id}/priority`, { key: KEYS.admin, body: { priority: 'high', reason: 'Scope is smaller' } });
    });
    await withApp({ persist: true, dataDir: dir }, async ({ call }) => {
      const t = (await call('GET', `/tickets/${id}`, { key: KEYS.viewer })).json.data;
      assert.equal(t.assignee, 'Ravi Kumar');
      assert.equal(t.priority, 'high');
      assert.equal(t.priorityOverridden, true);
      const c = (await call('GET', `/tickets/${id}/comments`, { key: KEYS.viewer })).json.data;
      assert.deepEqual(c.map((x) => x.text), ['Remember me']);
      const next = await call('POST', `/tickets/${id}/comments`, { key: KEYS.agent, body: { text: 'Second' } });
      assert.equal(next.json.data.id, 'cmt_0002'); // the comment counter survived too
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the shared self-check
test('self-check (the same module the dashboard and `npm run check` use) passes against a fresh server', async () => {
  await withApp({ notifier: { latencyMs: 0 } }, async ({ base, app }) => {
    const steps = [];
    const result = await SelfCheck.run({ base, keys: KEYS, onStep: (s) => steps.push(s) });
    const failures = result.results.filter((r) => r.status === 'fail');
    assert.deepEqual(failures, [], JSON.stringify(failures));
    assert.equal(result.passed, 19);
    assert.equal(result.skipped, 0);
    assert.equal(steps.length, 19);
    assert.equal(app.store.all().length, 0); // it cleaned up after itself
  });
});

test('self-check skips admin steps politely when no admin key is given', async () => {
  await withApp({}, async ({ base }) => {
    const result = await SelfCheck.run({ base, keys: { viewer: KEYS.viewer, agent: KEYS.agent } });
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 3);
    assert.equal(result.leftover, 2); // tickets are left behind and reported
  });
});
