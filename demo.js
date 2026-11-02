'use strict';
// npm run demo
// A guided 5-minute walkthrough of the API's best features. Start the server first (npm start).
const origin = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;
const BASE = `${origin}/api/v1`;
const KEY = {
  viewer: process.env.VIEWER_KEY || 'viewer-key-123',
  agent: process.env.AGENT_KEY || 'agent-key-123',
  admin: process.env.ADMIN_KEY || 'admin-key-123',
};
const RUN = Math.floor(Math.random() * 90000) + 10000;

async function call(method, path, key, body) {
  const headers = {};
  if (key) headers['x-api-key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  return { status: res.status, json, ms: Date.now() - t0 };
}
const show = (r) => console.log(`HTTP ${r.status} (${r.ms} ms)\n${r.json ? JSON.stringify(r.json, null, 2) : '(no body)'}`);
const step = (t) => console.log(`\n\x1b[1;34m== ${t}\x1b[0m`);

(async () => {
  try { await fetch(`${BASE}/health`); } catch (e) {
    console.error(`Could not reach the server at ${origin}. Start it first with:  npm start`);
    process.exit(2);
  }

  step('1. The API documents itself');
  const docs = await call('GET', '/docs');
  docs.json.data.endpoints.forEach((e) => console.log(e.method.padEnd(7), e.path.padEnd(32), e.summary.slice(0, 70)));

  step('2. Create a critical ticket (input -> triage -> output with SLA)');
  const created = await call('POST', '/tickets', KEY.agent, {
    email: `demo${RUN}@example.com`, title: `Checkout page is down ${RUN}`,
    description: 'Customers cannot pay, urgent fix needed.', category: 'outage', affectedUsers: 150,
  });
  show(created);
  const id = created.json.data.id;

  step('3. Gatekeeper: a bad payload gets a 400 with field-level details');
  show(await call('POST', '/tickets', KEY.agent, { title: 'ab', category: 'nonsense', extra: true }));

  step('4. Work the ticket: assign, comment, move forward');
  show(await call('PUT', `/tickets/${id}/assignee`, KEY.agent, { assignee: 'Ravi Kumar' }));
  show(await call('POST', `/tickets/${id}/comments`, KEY.agent, { text: 'Payment provider is investigating.' }));
  show(await call('PUT', `/tickets/${id}/status`, KEY.agent, { status: 'in_progress' }));
  console.log('\nHistory:');
  const hist = await call('GET', `/tickets/${id}/history`, KEY.viewer);
  hist.json.data.forEach((e) => console.log(' ', e.at, e.event.padEnd(22), e.actor));

  step('5. AuthZ: an agent cannot DELETE (403), an admin can (204)');
  show(await call('DELETE', `/tickets/${id}`, KEY.agent));
  show(await call('DELETE', `/tickets/${id}`, KEY.admin));

  step('6. Failure simulator: break the notifier and watch the circuit open');
  await call('PUT', '/admin/notifier', KEY.admin, { mode: 'failing' });
  for (let i = 1; i <= 4; i++) {
    const r = await call('POST', '/tickets', KEY.agent, {
      email: `demo${RUN}@example.com`, title: `Payment gateway down ${RUN}-${i}`,
      description: 'Payments are failing for everyone, urgent', category: 'outage', affectedUsers: 50,
    });
    console.log(`critical ticket ${i}: HTTP ${r.status} in ${r.ms} ms, notification = ${r.json.data.notification}`);
  }
  console.log('(tickets 1-3 take about 300 ms each; ticket 4 is instant because the circuit is OPEN)');
  const n = await call('GET', '/admin/notifier', KEY.admin);
  console.log('Notifier:', JSON.stringify(n.json.data));

  step('7. System pulse');
  const m = await call('GET', '/metrics', KEY.admin);
  console.log(JSON.stringify(m.json.data, null, 2));
  await call('PUT', '/admin/notifier', KEY.admin, { mode: 'healthy' });
  console.log('\nNotifier set back to healthy. Wait 20 seconds, create another critical ticket,');
  console.log('and the breaker closes and the queued notifications are delivered.');
})();
