/* SynapseGate dashboard. Plain JavaScript, no build step, no libraries.
 * All text is inserted with textContent (never innerHTML), so ticket content cannot inject code. */
(function () {
  'use strict';

  const BASE = location.origin + '/api/v1';
  const DEMO_KEYS = { viewer: 'viewer-key-123', agent: 'agent-key-123', admin: 'admin-key-123' };
  const NEXT_STATUS = { open: ['in_progress', 'resolved'], in_progress: ['resolved'], resolved: [] };

  const keys = loadKeys();
  const state = { role: 'admin', page: 1, limit: 10, timer: null, searchTimer: null };

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function loadKeys() {
    try {
      const saved = JSON.parse(localStorage.getItem('synapsegate_keys') || 'null');
      if (saved && typeof saved === 'object') return { ...DEMO_KEYS, ...saved };
    } catch (e) { /* storage unavailable */ }
    return { ...DEMO_KEYS };
  }
  function saveKeys() {
    try { localStorage.setItem('synapsegate_keys', JSON.stringify(keys)); } catch (e) { /* ignore */ }
  }

  async function api(method, path, { body, headers, key } = {}) {
    const h = { ...(headers || {}) };
    const k = key === undefined ? keys[state.role] : key;
    if (k) h['x-api-key'] = k;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    try {
      const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
      return { status: res.status, json, headers: res.headers };
    } catch (e) {
      return { status: 0, json: null, headers: new Headers() };
    }
  }

  function errText(res) {
    if (res.status === 0) return 'Cannot reach the server. Is it running (npm start)?';
    const e = res.json && res.json.error;
    if (!e) return `HTTP ${res.status}`;
    let msg = `${res.status} ${e.code}: ${e.message}`;
    if (Array.isArray(e.details) && e.details.length) msg += ' (' + e.details.join('; ') + ')';
    return msg;
  }

  function toast(message, kind = 'info') {
    const t = el('div', { class: `toast ${kind}`, text: message });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
  }

  const badge = (cls, text) => el('span', { class: `badge b-${cls}`, text: text || cls });

  function dueInfo(ticket) {
    if (ticket.status === 'resolved') return { text: 'done', overdue: false };
    const ms = Date.parse(ticket.slaDueAt) - Date.now();
    const abs = Math.abs(ms);
    const mins = Math.round(abs / 60000);
    const label = mins < 60 ? `${mins}m` : mins < 2880 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
    return ms < 0 ? { text: `overdue ${label}`, overdue: true } : { text: `in ${label}`, overdue: false };
  }

  const clock = (iso) => new Date(iso).toLocaleTimeString();
  const stamp = (iso) => new Date(iso).toLocaleString();

  // ------------------------------------------------------------------ health + stats
  async function refreshHealth() {
    const r = await api('GET', '/health', { key: null });
    const pill = $('#healthPill');
    if (r.status === 0) {
      pill.className = 'pill bad';
      pill.textContent = 'server unreachable';
      return;
    }
    const d = r.json && r.json.data;
    if (r.status === 200 && d) {
      pill.className = 'pill ok';
      pill.textContent = `healthy | breaker ${d.circuitBreaker.state} | up ${d.uptimeSeconds}s`;
    } else {
      pill.className = 'pill bad';
      pill.textContent = 'unhealthy';
    }
  }

  async function refreshStats() {
    const box = $('#statsRow');
    const r = await api('GET', '/stats');
    if (r.status !== 200) {
      box.replaceChildren(el('div', { class: 'stat' }, el('b', { text: '-' }), el('span', { text: r.status === 401 ? 'API key rejected' : 'stats unavailable' })));
      return;
    }
    const d = r.json.data;
    const card = (label, value, cls = '') => el('div', { class: `stat ${cls}` }, el('b', { text: String(value) }), el('span', { text: label }));
    box.replaceChildren(
      card('Total tickets', d.total),
      card('Critical', d.byPriority.critical, 'critical'),
      card('High', d.byPriority.high, 'high'),
      card('Open', d.byStatus.open),
      card('In progress', d.byStatus.in_progress),
      card('Resolved', d.byStatus.resolved),
      card('Overdue SLA', d.overdue, d.overdue > 0 ? 'bad' : ''),
    );
  }

  // ------------------------------------------------------------------ tickets table
  function ticketQuery() {
    const p = new URLSearchParams();
    p.set('page', state.page);
    p.set('limit', state.limit);
    const map = [['qSearch', 'search'], ['qPriority', 'priority'], ['qStatus', 'status'], ['qCategory', 'category'], ['qAssignee', 'assignee'], ['qOverdue', 'overdue']];
    for (const [id, name] of map) {
      const v = $('#' + id).value.trim();
      if (v) p.set(name, v);
    }
    p.set('sort', $('#qSort').value);
    return p.toString();
  }

  async function refreshTickets() {
    const body = $('#ticketRows');
    const pager = $('#pager');
    const r = await api('GET', '/tickets?' + ticketQuery());
    if (r.status !== 200) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'muted', text: errText(r) })));
      pager.replaceChildren();
      return;
    }
    const rows = r.json.data;
    const meta = r.json.meta;
    if (!rows.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'muted', text: 'No tickets match. Create one on the left.' })));
    } else {
      body.replaceChildren(...rows.map((t) => {
        const due = dueInfo(t);
        return el('tr', { onclick: () => openDetail(t.id) },
          el('td', { text: t.id }),
          el('td', { class: 'wrap', text: t.title }),
          el('td', {}, badge(t.priority), t.priorityOverridden ? el('small', { text: ' (override)' }) : null),
          el('td', { text: String(t.score) }),
          el('td', {}, badge(t.status)),
          el('td', { text: t.assignee || '-' }),
          el('td', { class: due.overdue ? 'over' : '', text: due.text }),
          el('td', { text: t.notification }));
      }));
    }
    pager.replaceChildren(
      el('button', { class: 'ghost', disabled: meta.page <= 1, onclick: () => { state.page -= 1; refreshTickets(); } }, 'Previous'),
      el('span', { class: 'muted', text: `Page ${meta.page} of ${Math.max(1, meta.totalPages)} | ${meta.total} tickets` }),
      el('button', { class: 'ghost', disabled: meta.page >= meta.totalPages, onclick: () => { state.page += 1; refreshTickets(); } }, 'Next'),
    );
  }

  // ------------------------------------------------------------------ resilience panel + activity log
  async function refreshOps() {
    const ops = $('#opsBody');
    const log = $('#logBody');
    if (state.role !== 'admin') {
      ops.replaceChildren(el('p', { class: 'muted', text: 'Choose the Admin role (top right) to see metrics and use the failure simulator.' }));
      log.replaceChildren(el('span', { class: 'muted', text: 'Admin role only.' }));
      return;
    }
    const [n, m, l] = await Promise.all([api('GET', '/admin/notifier'), api('GET', '/metrics'), api('GET', '/admin/logs?limit=15')]);
    if (n.status !== 200 || m.status !== 200) {
      ops.replaceChildren(el('p', { class: 'muted', text: errText(n.status !== 200 ? n : m) }));
      return;
    }
    const nd = n.json.data;
    const md = m.json.data;
    const kv = (label, value) => el('div', {}, el('b', { text: String(value) }), el('span', { text: label }));
    ops.replaceChildren(
      el('div', { class: 'inline' },
        el('span', { text: 'Circuit breaker:' }), badge(nd.circuitBreaker.state),
        el('span', { text: 'Notifier mode:' }), el('b', { text: nd.mode }),
        el('span', { text: `Queued notifications: ${nd.circuitBreaker.queued}` })),
      el('div', { class: 'btns' },
        el('button', { class: 'warn', disabled: nd.mode === 'failing', onclick: () => setMode('failing') }, 'Make notifier fail'),
        el('button', { class: 'ghost', disabled: nd.mode === 'healthy', onclick: () => setMode('healthy') }, 'Make notifier healthy')),
      el('p', { class: 'muted', text: 'Tip: set it to fail, create 3 critical tickets (outage + "down" + "urgent" + 50 users), then a 4th. The 4th is instant because the circuit opened. Set it back to healthy, wait 20 s, create another critical ticket and the queue is delivered.' }),
      el('h3', { text: 'Vital signs' }),
      el('div', { class: 'kv' },
        kv('Requests', md.totalRequests), kv('Per minute', md.requestsPerMinute),
        kv('Avg latency', md.avgLatencyMs + ' ms'), kv('p95 latency', md.p95LatencyMs + ' ms'),
        kv('Availability', md.availabilityPercent + '%'), kv('Rate limited', md.rateLimited),
        kv('2xx', md.statusBreakdown['2xx']), kv('4xx', md.statusBreakdown['4xx']), kv('5xx', md.statusBreakdown['5xx'])),
    );
    if (l.status === 200) {
      log.replaceChildren(...(l.json.data.length ? l.json.data.map((e) => el('div', {},
        `${clock(e.at)}  ${e.method.padEnd(6)} `,
        el('span', { class: 's' + String(e.status)[0], text: String(e.status) }),
        `  ${e.path}  ${e.latencyMs}ms  ${e.role || '-'}`)) : [el('span', { class: 'muted', text: 'No requests yet.' })]));
    }
  }

  async function setMode(mode) {
    const r = await api('PUT', '/admin/notifier', { body: { mode } });
    if (r.status === 200) toast(`Notifier is now ${mode}`, 'ok');
    else toast(errText(r), 'err');
    refreshAll();
  }

  // ------------------------------------------------------------------ create form
  function fillExample() {
    const n = Math.floor(Math.random() * 900) + 100;
    $('#fEmail').value = 'asha@example.com';
    $('#fCategory').value = 'outage';
    $('#fTitle').value = `Checkout page is down #${n}`;
    $('#fDesc').value = 'Customers cannot pay, urgent fix needed.';
    $('#fUsers').value = '150';
  }

  async function submitCreate(ev) {
    ev.preventDefault();
    const body = {
      email: $('#fEmail').value, title: $('#fTitle').value,
      description: $('#fDesc').value, category: $('#fCategory').value,
    };
    if ($('#fUsers').value !== '') body.affectedUsers = Number($('#fUsers').value);
    const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const r = await api('POST', '/tickets', { body, headers: { 'Idempotency-Key': key } });
    const box = $('#createResult');
    if (r.status === 201) {
      const t = r.json.data;
      const b = t.scoreBreakdown;
      box.replaceChildren(el('div', { class: 'result ok' },
        el('b', { text: `Created ${t.id}: ` }), badge(t.priority), ` score ${t.score}`,
        el('div', { class: 'muted', text: `Score = category ${b.category} + keywords ${b.keywords}${b.matchedKeywords.length ? ' (' + b.matchedKeywords.join(', ') + ')' : ''} + audience ${b.audience}` }),
        el('div', { class: 'muted', text: `SLA due ${stamp(t.slaDueAt)} | notification: ${t.notification}` })));
      toast(`Created ${t.id}`, 'ok');
      refreshAll();
    } else {
      const e = r.json && r.json.error;
      box.replaceChildren(el('div', { class: 'result err' },
        el('b', { text: r.status === 0 ? errText(r) : `${r.status} ${e ? e.code : 'error'}: ${e ? e.message : ''}` }),
        e && e.details ? el('ul', {}, e.details.map((d) => el('li', { text: d }))) : null));
    }
  }

  // ------------------------------------------------------------------ ticket detail dialog
  async function openDetail(id) {
    const dlg = $('#detail');
    dlg.replaceChildren(el('div', { class: 'dlg' }, el('p', { text: 'Loading...' })));
    if (!dlg.open) dlg.showModal();
    await renderDetail(id);
  }

  async function renderDetail(id) {
    const dlg = $('#detail');
    const [t, c, h] = await Promise.all([
      api('GET', `/tickets/${id}`), api('GET', `/tickets/${id}/comments`), api('GET', `/tickets/${id}/history`),
    ]);
    if (t.status !== 200) {
      dlg.replaceChildren(el('div', { class: 'dlg' }, el('p', { text: errText(t) }), el('button', { onclick: () => dlg.close() }, 'Close')));
      return;
    }
    const tk = t.json.data;
    const canWrite = state.role !== 'viewer';
    const isAdmin = state.role === 'admin';
    const due = dueInfo(tk);
    const b = tk.scoreBreakdown;

    async function act(fn, okMsg) {
      const r = await fn();
      if (r.status >= 200 && r.status < 300) toast(okMsg, 'ok');
      else toast(errText(r), 'err');
      if (r.status === 204) { dlg.close(); } else await renderDetail(id);
      refreshAll();
    }

    const assigneeInput = el('input', { type: 'text', class: 'grow', placeholder: 'Assign to (2-50 characters)', value: tk.assignee || '' });
    const commentInput = el('textarea', { placeholder: 'Write a comment (1-500 characters)' });
    const prioSelect = el('select', {}, ['critical', 'high', 'medium', 'low'].map((p) => el('option', { value: p, selected: p === tk.priority }, p)));
    const reasonInput = el('input', { type: 'text', class: 'grow', placeholder: 'Reason for the override (5-200 characters)' });

    const nodes = [
      el('div', { class: 'dlg-head' },
        el('div', {}, el('h2', { text: `${tk.id}: ${tk.title}` }),
          el('div', {}, badge(tk.priority), ' ', badge(tk.status), tk.priorityOverridden ? el('small', { text: '  priority overridden by an admin' }) : null)),
        el('button', { class: 'ghost', onclick: () => dlg.close() }, 'Close')),
      el('p', { text: tk.description }),
      el('div', { class: 'kv' },
        el('div', {}, el('b', { text: String(tk.score) }), el('span', { text: 'Score' })),
        el('div', {}, el('b', { class: due.overdue ? 'over' : '', text: due.text }), el('span', { text: 'SLA' })),
        el('div', {}, el('b', { text: tk.notification }), el('span', { text: 'Notification' })),
        el('div', {}, el('b', { text: tk.assignee || '-' }), el('span', { text: 'Assignee' })),
        el('div', {}, el('b', { text: tk.affectedUsers === null ? '-' : String(tk.affectedUsers) }), el('span', { text: 'Affected users' }))),
      el('p', { class: 'muted', text: `${tk.email} | ${tk.category} | created ${stamp(tk.createdAt)} | score = category ${b.category} + keywords ${b.keywords} + audience ${b.audience}` }),
    ];

    if (canWrite) {
      nodes.push(
        el('h3', { text: 'Status' }),
        el('div', { class: 'btns' },
          NEXT_STATUS[tk.status].length
            ? NEXT_STATUS[tk.status].map((s) => el('button', { onclick: () => act(() => api('PUT', `/tickets/${id}/status`, { body: { status: s } }), `Status is now ${s}`) }, `Mark ${s.replace('_', ' ')}`))
            : el('span', { class: 'muted', text: 'Resolved tickets cannot be reopened.' })),
        el('h3', { text: 'Assignee' }),
        el('div', { class: 'inline' }, assigneeInput,
          el('button', { onclick: () => act(() => api('PUT', `/tickets/${id}/assignee`, { body: { assignee: assigneeInput.value } }), 'Assignee saved') }, 'Save'),
          el('button', { class: 'ghost', onclick: () => act(() => api('PUT', `/tickets/${id}/assignee`, { body: { assignee: null } }), 'Ticket unassigned') }, 'Unassign')),
      );
    } else {
      nodes.push(el('p', { class: 'muted', text: 'Viewer role is read-only. Choose Agent or Admin to make changes.' }));
    }

    if (isAdmin) {
      nodes.push(
        el('h3', { text: 'Override priority (admin)' }),
        el('div', { class: 'inline' }, prioSelect, reasonInput,
          el('button', { class: 'warn', onclick: () => act(() => api('PUT', `/tickets/${id}/priority`, { body: { priority: prioSelect.value, reason: reasonInput.value } }), 'Priority overridden') }, 'Apply')),
      );
    }

    nodes.push(el('h3', { text: `Comments (${c.status === 200 ? c.json.data.length : 0})` }));
    if (c.status === 200 && c.json.data.length) {
      for (const cm of c.json.data) {
        nodes.push(el('div', { class: 'comment' }, el('small', { text: `${cm.author} | ${stamp(cm.createdAt)}` }), el('div', { text: cm.text })));
      }
    } else {
      nodes.push(el('p', { class: 'muted', text: 'No comments yet.' }));
    }
    if (canWrite) {
      nodes.push(commentInput, el('div', { class: 'btns' },
        el('button', { onclick: () => act(() => api('POST', `/tickets/${id}/comments`, { body: { text: commentInput.value } }), 'Comment added') }, 'Add comment')));
    }

    nodes.push(el('h3', { text: 'History' }));
    if (h.status === 200) {
      nodes.push(el('ul', { class: 'timeline' }, h.json.data.map((e) => {
        const d = e.details && Object.keys(e.details).length ? ' ' + JSON.stringify(e.details) : '';
        return el('li', { text: `${stamp(e.at)}  ${e.event}  by ${e.actor}${d}` });
      })));
    }

    if (isAdmin) {
      nodes.push(el('div', { class: 'btns' },
        el('button', { class: 'danger', onclick: () => { if (confirm(`Delete ${id} and its history?`)) act(() => api('DELETE', `/tickets/${id}`), 'Ticket deleted'); } }, 'Delete ticket')));
    }

    dlg.replaceChildren(el('div', { class: 'dlg' }, nodes));
  }

  // ------------------------------------------------------------------ self-check
  async function runSelfCheck() {
    const btn = $('#runCheck');
    const out = $('#checkResults');
    const sum = $('#checkSummary');
    btn.disabled = true;
    out.replaceChildren();
    sum.replaceChildren(el('p', { class: 'muted', text: 'Running...' }));
    const icon = { pass: '\u2713', fail: '\u2717', skipped: '-' };
    const result = await window.SelfCheck.run({
      base: BASE,
      keys,
      onStep: (r) => out.append(el('div', { class: `checkrow ${r.status}` },
        el('span', { class: 'ic', text: icon[r.status] }),
        el('div', {}, el('span', { class: 'nm', text: r.name }), r.detail ? el('small', { class: 'muted', text: r.detail }) : null),
        el('small', { class: 'muted', text: `${r.ms} ms` }))),
    });
    sum.replaceChildren(el('div', { class: `result ${result.failed ? 'err' : 'ok'}` },
      el('b', { text: `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped` }),
      result.failed ? el('div', { text: 'If every step fails with 401, the keys above do not match the keys the server was started with.' }) : null));
    btn.disabled = false;
    refreshAll();
  }

  // ------------------------------------------------------------------ wiring
  function refreshAll() {
    refreshHealth();
    refreshStats();
    refreshTickets();
    refreshOps();
  }

  function syncKeyInputs() {
    $('#keyInput').value = keys[state.role];
    $('#kViewer').value = keys.viewer;
    $('#kAgent').value = keys.agent;
    $('#kAdmin').value = keys.admin;
  }

  function init() {
    $('#roleSelect').value = state.role;
    syncKeyInputs();

    $('#roleSelect').addEventListener('change', (e) => { state.role = e.target.value; syncKeyInputs(); state.page = 1; refreshAll(); });
    $('#keyInput').addEventListener('change', (e) => { keys[state.role] = e.target.value.trim(); saveKeys(); syncKeyInputs(); refreshAll(); });
    for (const [id, role] of [['kViewer', 'viewer'], ['kAgent', 'agent'], ['kAdmin', 'admin']]) {
      $('#' + id).addEventListener('change', (e) => { keys[role] = e.target.value.trim(); saveKeys(); syncKeyInputs(); refreshAll(); });
    }
    $('#createForm').addEventListener('submit', submitCreate);
    $('#fillExample').addEventListener('click', fillExample);
    $('#runCheck').addEventListener('click', runSelfCheck);

    const reload = () => { state.page = 1; refreshTickets(); };
    for (const id of ['qPriority', 'qStatus', 'qCategory', 'qOverdue', 'qSort']) $('#' + id).addEventListener('change', reload);
    for (const id of ['qSearch', 'qAssignee']) {
      $('#' + id).addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(reload, 300); });
    }

    fillExample();
    refreshAll();
    state.timer = setInterval(() => {
      if ($('#autoRefresh').checked && !document.hidden && !$('#detail').open) refreshAll();
    }, 10000);
  }

  init();
})();
