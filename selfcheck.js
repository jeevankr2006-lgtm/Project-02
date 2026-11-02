/* SynapseGate self-check.
 * Calls the real API end to end and reports pass / fail for each step.
 * Works in the browser (dashboard) and in Node 18+ (npm run check).
 * It creates two clearly named test tickets and deletes them at the end
 * (the cleanup step needs the admin key). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SelfCheck = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  async function run({ base, keys = {}, onStep } = {}) {
    const results = [];
    const marker = 'chk' + Date.now().toString(36);
    const created = [];
    let id1 = null;

    async function call(method, path, { key, body, headers = {} } = {}) {
      const h = { ...headers };
      if (key) h['x-api-key'] = key;
      let payload;
      if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
      const res = await fetch(base + path, { method, headers: h, body: payload });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
      return { status: res.status, json, headers: res.headers, text };
    }

    const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
    const expectStatus = (res, code) => {
      const extra = res.json && res.json.error ? ` (${res.json.error.code}: ${res.json.error.message})` : '';
      expect(res.status === code, `expected HTTP ${code} but got ${res.status}${extra}`);
    };
    const needTicket = () => expect(id1, 'the test ticket was not created in an earlier step');
    const body = (suffix) => ({
      email: 'selfcheck@example.com',
      title: `Self-check ticket ${marker} ${suffix}`,
      description: `Automatic self-check ticket ${marker}. Safe to delete.`,
      category: 'bug',
      affectedUsers: 5,
    });

    async function step(name, needs, fn) {
      const t0 = Date.now();
      let r;
      if (needs && !keys[needs]) {
        r = { name, status: 'skipped', detail: `needs the ${needs} key` };
      } else {
        try {
          const detail = await fn();
          r = { name, status: 'pass', detail: detail || '' };
        } catch (e) {
          r = { name, status: 'fail', detail: e && e.message ? e.message : String(e) };
        }
      }
      r.ms = Date.now() - t0;
      results.push(r);
      if (onStep) onStep(r);
    }

    await step('GET /health is up', null, async () => {
      const r = await call('GET', '/health');
      expectStatus(r, 200);
      expect(r.json.data.status === 'ok', 'health status is not ok');
      return `breaker ${r.json.data.circuitBreaker.state}, store ${r.json.data.dataStore.mode}`;
    });

    await step('GET /docs lists the endpoints', null, async () => {
      const r = await call('GET', '/docs');
      expectStatus(r, 200);
      expect(r.json.data.endpoints.length >= 15, 'fewer endpoints than expected');
      return `${r.json.data.endpoints.length} endpoints documented`;
    });

    await step('Missing API key is rejected (401)', null, async () => {
      const r = await call('GET', '/tickets');
      expectStatus(r, 401);
      expect(r.json.error.code === 'UNAUTHORIZED', 'wrong error code');
    });

    await step('Gatekeeper rejects a bad ticket (400)', 'agent', async () => {
      const r = await call('POST', '/tickets', { key: keys.agent, body: { title: 'ab', category: 'nope' } });
      expectStatus(r, 400);
      expect(Array.isArray(r.json.error.details) && r.json.error.details.length > 0, 'no field-level details');
      return `${r.json.error.details.length} problems reported`;
    });

    await step('POST /tickets creates a ticket (201)', 'agent', async () => {
      const r = await call('POST', '/tickets', { key: keys.agent, body: body('a') });
      expectStatus(r, 201);
      const t = r.json.data;
      expect(/^tkt_\d+$/.test(t.id), 'bad ticket id');
      expect(typeof t.score === 'number' && t.priority, 'score or priority missing');
      id1 = t.id;
      created.push(t.id);
      return `${t.id}: score ${t.score}, priority ${t.priority}`;
    });

    await step('Identical ticket is refused (DUPLICATE_TICKET)', 'agent', async () => {
      needTicket();
      const r = await call('POST', '/tickets', { key: keys.agent, body: body('a') });
      expectStatus(r, 400);
      expect(r.json.error.code === 'DUPLICATE_TICKET', `got ${r.json.error.code}`);
    });

    await step('Idempotency-Key makes a retry safe', 'agent', async () => {
      const headers = { 'Idempotency-Key': marker };
      const a = await call('POST', '/tickets', { key: keys.agent, body: body('b'), headers });
      expectStatus(a, 201);
      created.push(a.json.data.id);
      const b = await call('POST', '/tickets', { key: keys.agent, body: body('b'), headers });
      expectStatus(b, 201);
      expect(b.json.data.id === a.json.data.id, 'the retry created a second ticket');
      expect(b.headers.get('idempotent-replayed') === 'true', 'missing Idempotent-Replayed header');
      return `retry returned the same ticket ${a.json.data.id}`;
    });

    await step('GET /tickets/{id} returns the ticket', 'viewer', async () => {
      needTicket();
      const r = await call('GET', `/tickets/${id1}`, { key: keys.viewer });
      expectStatus(r, 200);
      expect(r.json.data.id === id1, 'wrong ticket returned');
    });

    await step('GET /tickets search and filters work', 'viewer', async () => {
      const r = await call('GET', `/tickets?search=${marker}&limit=10`, { key: keys.viewer });
      expectStatus(r, 200);
      expect(r.json.meta.total >= 2, `expected 2 or more matches, found ${r.json.meta.total}`);
      return `${r.json.meta.total} tickets matched`;
    });

    await step('PUT status moves forward, never back', 'agent', async () => {
      needTicket();
      const up = await call('PUT', `/tickets/${id1}/status`, { key: keys.agent, body: { status: 'in_progress' } });
      expectStatus(up, 200);
      const back = await call('PUT', `/tickets/${id1}/status`, { key: keys.agent, body: { status: 'open' } });
      expectStatus(back, 400);
      expect(back.json.error.code === 'INVALID_STATUS_TRANSITION', `got ${back.json.error.code}`);
    });

    await step('PUT assignee and filter by assignee', 'agent', async () => {
      needTicket();
      const put = await call('PUT', `/tickets/${id1}/assignee`, { key: keys.agent, body: { assignee: 'Self Check' } });
      expectStatus(put, 200);
      expect(put.json.data.assignee === 'Self Check', 'assignee not saved');
      const list = await call('GET', '/tickets?assignee=' + encodeURIComponent('Self Check'), { key: keys.agent });
      expectStatus(list, 200);
      expect(list.json.meta.total >= 1, 'assignee filter found nothing');
    });

    await step('Comments can be added and listed', 'agent', async () => {
      needTicket();
      const post = await call('POST', `/tickets/${id1}/comments`, { key: keys.agent, body: { text: 'Self-check comment' } });
      expectStatus(post, 201);
      const list = await call('GET', `/tickets/${id1}/comments`, { key: keys.agent });
      expectStatus(list, 200);
      expect(list.json.data.length === 1, `expected 1 comment, found ${list.json.data.length}`);
    });

    await step('History records every change', 'agent', async () => {
      needTicket();
      const r = await call('GET', `/tickets/${id1}/history`, { key: keys.agent });
      expectStatus(r, 200);
      const events = r.json.data.map((e) => e.event);
      for (const want of ['created', 'status_changed', 'assignee_changed', 'comment_added']) {
        expect(events.includes(want), `history is missing "${want}"`);
      }
      return events.join(', ');
    });

    await step('GET /stats returns counts', 'viewer', async () => {
      const r = await call('GET', '/stats', { key: keys.viewer });
      expectStatus(r, 200);
      expect(r.json.data.total >= 1, 'total is 0');
      return `${r.json.data.total} tickets in total`;
    });

    await step('Viewer is read-only (403 on POST)', 'viewer', async () => {
      const r = await call('POST', '/tickets', { key: keys.viewer, body: body('v') });
      expectStatus(r, 403);
    });

    await step('Admin can override priority', 'admin', async () => {
      needTicket();
      const r = await call('PUT', `/tickets/${id1}/priority`, {
        key: keys.admin, body: { priority: 'high', reason: 'Self-check priority override' },
      });
      expectStatus(r, 200);
      expect(r.json.data.priority === 'high' && r.json.data.priorityOverridden === true, 'override not applied');
    });

    await step('Admin ops: /metrics, /admin/notifier, /admin/logs', 'admin', async () => {
      const m = await call('GET', '/metrics', { key: keys.admin });
      expectStatus(m, 200);
      const n = await call('GET', '/admin/notifier', { key: keys.admin });
      expectStatus(n, 200);
      const l = await call('GET', '/admin/logs?limit=5', { key: keys.admin });
      expectStatus(l, 200);
      expect(Array.isArray(l.json.data), 'logs is not a list');
      return `availability ${m.json.data.availabilityPercent}%, notifier ${n.json.data.mode}`;
    });

    await step('Agent cannot DELETE (403)', 'agent', async () => {
      needTicket();
      const r = await call('DELETE', `/tickets/${id1}`, { key: keys.agent });
      expectStatus(r, 403);
    });

    await step('Cleanup: admin deletes the test tickets (204)', 'admin', async () => {
      for (const id of created) {
        const r = await call('DELETE', `/tickets/${id}`, { key: keys.admin });
        expectStatus(r, 204);
      }
      if (id1) {
        const gone = await call('GET', `/tickets/${id1}`, { key: keys.admin });
        expectStatus(gone, 404);
      }
      return `${created.length} test tickets removed`;
    });

    const count = (s) => results.filter((r) => r.status === s).length;
    return { results, passed: count('pass'), failed: count('fail'), skipped: count('skipped'), leftover: created.length };
  }

  return { run };
});
