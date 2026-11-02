'use strict';
// THE ROUTE REGISTRY: every route is declared once, here. The same list
// mounts the routes AND generates GET /docs, so documentation cannot drift
// from the code ("If it isn't documented, it doesn't exist").
const tickets = require('./modules/tickets/handlers');
const ops = require('./modules/ops/handlers');
const { docs } = require('./modules/docs/docs');

const ALL = ['viewer', 'agent', 'admin'];
const WRITE = ['agent', 'admin'];
const ADMIN = ['admin'];

const exampleTicket = {
  id: 'tkt_0001', email: 'asha@example.com', title: 'Checkout page is down',
  description: 'Customers cannot pay, urgent fix needed.', category: 'outage', affectedUsers: 150,
  score: 90, priority: 'critical', priorityOverridden: false,
  scoreBreakdown: { category: 40, keywords: 30, audience: 20, matchedKeywords: ['urgent', 'down'] },
  status: 'open', assignee: null, slaDueAt: '2026-10-10T11:30:00.000Z', notification: 'sent',
  createdAt: '2026-10-10T10:30:00.000Z', updatedAt: '2026-10-10T10:30:00.000Z',
};
const exampleBody = {
  email: 'asha@example.com', title: 'Checkout page is down',
  description: 'Customers cannot pay, urgent fix needed.', category: 'outage', affectedUsers: 150,
};
const rid = (n) => ({ requestId: `req_8f3a${n}` });

function buildRegistry() {
  const registry = [
    {
      method: 'GET', path: '/', summary: 'API index with links to the dashboard, docs and health',
      roles: 'public', successStatus: 200, errors: [429],
      exampleResponse: { data: { name: 'SynapseGate', version: '2.0.0', links: { dashboard: '/', docs: '/api/v1/docs', health: '/api/v1/health' } }, meta: rid(10) },
      handler: ops.apiIndex,
    },
    {
      method: 'POST', path: '/tickets', summary: 'Create a ticket (optional Idempotency-Key header makes retries safe)',
      roles: WRITE, successStatus: 201, errors: [400, 401, 403, 429, 500],
      exampleHeaders: { 'Idempotency-Key': 'checkout-outage-001' },
      exampleBody, exampleResponse: { data: exampleTicket, meta: rid(21) },
      handler: tickets.createTicket,
    },
    {
      method: 'GET', path: '/tickets',
      summary: 'List tickets. Filters: priority, status, category, assignee, search, overdue, createdFrom, createdTo. Sort and pagination.',
      roles: ALL, successStatus: 200, errors: [400, 401, 429, 500],
      exampleQuery: '?priority=critical&status=open&search=checkout&sort=-score&page=1&limit=10',
      exampleResponse: { data: [exampleTicket], meta: { page: 1, limit: 10, total: 1, totalPages: 1, ...rid(22) } },
      handler: tickets.listTickets,
    },
    {
      method: 'GET', path: '/tickets/:id', summary: 'Fetch one ticket',
      roles: ALL, successStatus: 200, errors: [401, 404, 429],
      examplePath: '/tickets/tkt_0001',
      exampleResponse: { data: exampleTicket, meta: rid(23) },
      handler: tickets.getTicket,
    },
    {
      method: 'PUT', path: '/tickets/:id/status', summary: 'Move a ticket forward: open -> in_progress -> resolved (no reopening)',
      roles: WRITE, successStatus: 200, errors: [400, 401, 403, 404, 429],
      examplePath: '/tickets/tkt_0001/status', exampleBody: { status: 'in_progress' },
      exampleResponse: { data: { ...exampleTicket, status: 'in_progress' }, meta: rid(24) },
      handler: tickets.updateStatus,
    },
    {
      method: 'PUT', path: '/tickets/:id/assignee', summary: 'Assign a ticket to a person, or pass null to unassign (idempotent)',
      roles: WRITE, successStatus: 200, errors: [400, 401, 403, 404, 429],
      examplePath: '/tickets/tkt_0001/assignee', exampleBody: { assignee: 'Ravi Kumar' },
      exampleResponse: { data: { ...exampleTicket, assignee: 'Ravi Kumar' }, meta: rid(25) },
      handler: tickets.setAssignee,
    },
    {
      method: 'PUT', path: '/tickets/:id/priority',
      summary: 'Admin override of the triage priority with a reason; the SLA clock restarts from the override',
      roles: ADMIN, successStatus: 200, errors: [400, 401, 403, 404, 429],
      examplePath: '/tickets/tkt_0001/priority', exampleBody: { priority: 'high', reason: 'Impact is smaller than first reported' },
      exampleResponse: { data: { ...exampleTicket, priority: 'high', priorityOverridden: true }, meta: rid(26) },
      handler: tickets.setPriority,
    },
    {
      method: 'POST', path: '/tickets/:id/comments', summary: 'Add a comment to a ticket',
      roles: WRITE, successStatus: 201, errors: [400, 401, 403, 404, 429],
      examplePath: '/tickets/tkt_0001/comments', exampleBody: { text: 'Payment provider confirmed an outage on their side.' },
      exampleResponse: { data: { id: 'cmt_0001', ticketId: 'tkt_0001', text: 'Payment provider confirmed an outage on their side.', author: 'agent', createdAt: '2026-10-10T10:40:00.000Z' }, meta: rid(27) },
      handler: tickets.createComment,
    },
    {
      method: 'GET', path: '/tickets/:id/comments', summary: 'List the comments on a ticket (oldest first)',
      roles: ALL, successStatus: 200, errors: [401, 404, 429],
      examplePath: '/tickets/tkt_0001/comments',
      exampleResponse: { data: [{ id: 'cmt_0001', ticketId: 'tkt_0001', text: 'Payment provider confirmed an outage on their side.', author: 'agent', createdAt: '2026-10-10T10:40:00.000Z' }], meta: rid(28) },
      handler: tickets.listComments,
    },
    {
      method: 'GET', path: '/tickets/:id/history', summary: 'Audit trail of every change to a ticket',
      roles: ALL, successStatus: 200, errors: [401, 404, 429],
      examplePath: '/tickets/tkt_0001/history',
      exampleResponse: { data: [
        { at: '2026-10-10T10:30:00.000Z', event: 'created', actor: 'agent', details: { score: 90, priority: 'critical' } },
        { at: '2026-10-10T10:30:00.350Z', event: 'notification_sent', actor: 'system', details: {} },
      ], meta: rid(29) },
      handler: tickets.getHistory,
    },
    {
      method: 'DELETE', path: '/tickets/:id', summary: 'Remove a ticket, its comments and history (admin only)',
      roles: ADMIN, successStatus: 204, errors: [401, 403, 404, 429],
      examplePath: '/tickets/tkt_0001', exampleResponse: null,
      handler: tickets.deleteTicket,
    },
    {
      method: 'GET', path: '/stats', summary: 'Ticket counts by priority, status and category, plus overdue SLA count',
      roles: ALL, successStatus: 200, errors: [401, 429, 500],
      exampleResponse: { data: {
        total: 1, byPriority: { low: 0, medium: 0, high: 0, critical: 1 },
        byStatus: { open: 1, in_progress: 0, resolved: 0 },
        byCategory: { security: 0, outage: 1, billing: 0, bug: 0, general: 0 }, overdue: 0,
      }, meta: rid(30) },
      handler: tickets.getStats,
    },
    {
      method: 'GET', path: '/health', summary: 'Public pulse: status, uptime, circuit breaker state and data-store integrity check',
      roles: 'public', successStatus: 200, errors: [429, 500],
      exampleResponse: { data: {
        status: 'ok', version: '2.0.0', timestamp: '2026-10-10T10:30:00.000Z', uptimeSeconds: 5230,
        circuitBreaker: { state: 'CLOSED' }, dataStore: { ok: true, mode: 'file' },
      }, meta: rid(31) },
      handler: ops.health,
    },
    {
      method: 'GET', path: '/metrics', summary: 'Latency, throughput, availability, error and rate-limit figures (admin only)',
      roles: ADMIN, successStatus: 200, errors: [401, 403, 429],
      exampleResponse: { data: {
        uptimeSeconds: 5230, totalRequests: 412, statusBreakdown: { '2xx': 371, '4xx': 38, '5xx': 3 },
        avgLatencyMs: 14, p95LatencyMs: 41, requestsPerMinute: 5, availabilityPercent: 99.27, rateLimited: 6,
        circuitBreaker: { state: 'CLOSED', consecutiveFailures: 0, queued: 0 },
      }, meta: rid(32) },
      handler: ops.metrics,
    },
    {
      method: 'GET', path: '/docs', summary: 'This documentation, generated from the route registry',
      roles: 'public', successStatus: 200, errors: [429, 500],
      exampleResponse: { data: { name: 'SynapseGate', endpoints: ['...'] }, meta: rid(33) },
      handler: null, // assigned below (needs the registry itself)
    },
    {
      method: 'GET', path: '/admin/notifier', summary: 'Current notifier mode, circuit breaker state, queue size and delivery counters (admin only)',
      roles: ADMIN, successStatus: 200, errors: [401, 403, 429],
      exampleResponse: { data: { mode: 'healthy', circuitBreaker: { state: 'CLOSED', consecutiveFailures: 0, queued: 0 }, attempts: 12, delivered: 12 }, meta: rid(34) },
      handler: ops.getNotifier,
    },
    {
      method: 'PUT', path: '/admin/notifier', summary: 'Failure simulator: set the notifier to "healthy" or "failing" (admin only)',
      roles: ADMIN, successStatus: 200, errors: [400, 401, 403, 429],
      exampleBody: { mode: 'failing' },
      exampleResponse: { data: { mode: 'failing', circuitBreaker: { state: 'CLOSED', consecutiveFailures: 0, queued: 0 } }, meta: rid(35) },
      handler: ops.setNotifierMode,
    },
    {
      method: 'GET', path: '/admin/logs',
      summary: 'Most recent API requests, newest first (admin only). Polling calls to /health and /admin/logs are left out.',
      roles: ADMIN, successStatus: 200, errors: [400, 401, 403, 429],
      exampleQuery: '?limit=20',
      exampleResponse: { data: [{ at: '2026-10-10T10:30:00.000Z', requestId: 'req_8f3a21', method: 'POST', path: '/api/v1/tickets', status: 201, latencyMs: 12.4, role: 'agent' }], meta: rid(36) },
      handler: ops.getLogs,
    },
  ];
  registry.find((r) => r.path === '/docs').handler = (ctx) => docs(ctx, registry);
  return registry;
}

module.exports = { buildRegistry };
