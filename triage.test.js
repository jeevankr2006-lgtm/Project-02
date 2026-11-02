'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { triage, priorityFor } = require('../src/modules/tickets/triage');

const t = (over) => triage({ title: 'Something happened', description: 'Nothing special to report here', category: 'general', ...over });

test('worked example from the spec: outage + down + urgent + 150 users = 90, critical, 1h SLA', () => {
  const r = triage({
    title: 'Checkout page is down', description: 'Customers cannot pay, urgent fix needed.',
    category: 'outage', affectedUsers: 150,
  });
  assert.equal(r.score, 90);
  assert.equal(r.priority, 'critical');
  assert.equal(r.slaHours, 1);
  assert.equal(r.notifyRequired, true);
  assert.deepEqual(r.scoreBreakdown.matchedKeywords.sort(), ['down', 'urgent']);
});

test('category points', () => {
  assert.equal(t({ category: 'security' }).score, 45);
  assert.equal(t({ category: 'outage' }).score, 40);
  assert.equal(t({ category: 'billing' }).score, 20);
  assert.equal(t({ category: 'bug' }).score, 15);
  assert.equal(t({ category: 'general' }).score, 5);
});

test('keywords add 15 each and are capped at +30', () => {
  assert.equal(t({ title: 'Site is down' }).scoreBreakdown.keywords, 15);
  assert.equal(t({ title: 'Urgent: site down, breach, payment failed' }).scoreBreakdown.keywords, 30);
  assert.equal(t({ title: 'Customers cannot login at all' }).scoreBreakdown.keywords, 15);
});

test('keywords match whole words only ("download" is not "down")', () => {
  assert.equal(t({ title: 'Please fix the download link' }).scoreBreakdown.keywords, 0);
});

test('audience points: <10 = 0, 10-99 = 10, 100+ = 20', () => {
  assert.equal(t({ affectedUsers: 9 }).scoreBreakdown.audience, 0);
  assert.equal(t({ affectedUsers: 10 }).scoreBreakdown.audience, 10);
  assert.equal(t({ affectedUsers: 99 }).scoreBreakdown.audience, 10);
  assert.equal(t({ affectedUsers: 100 }).scoreBreakdown.audience, 20);
  assert.equal(t({}).scoreBreakdown.audience, 0);
});

test('priority boundaries and SLA hours', () => {
  assert.equal(priorityFor(0), 'low');
  assert.equal(priorityFor(29), 'low');
  assert.equal(priorityFor(30), 'medium');
  assert.equal(priorityFor(59), 'medium');
  assert.equal(priorityFor(60), 'high');
  assert.equal(priorityFor(79), 'high');
  assert.equal(priorityFor(80), 'critical');
  assert.equal(priorityFor(100), 'critical');
  assert.equal(t({ category: 'general' }).slaHours, 72);
  assert.equal(t({ category: 'billing', affectedUsers: 10 }).slaHours, 24); // 30 = medium
  assert.equal(t({ category: 'outage', affectedUsers: 100 }).slaHours, 4); // 60 = high
});

test('only high and critical tickets require the notifier', () => {
  assert.equal(t({ category: 'billing', affectedUsers: 10 }).notifyRequired, false); // medium
  assert.equal(t({ category: 'outage', affectedUsers: 100 }).notifyRequired, true); // high
});

test('score never exceeds 100 (theoretical maximum is 95)', () => {
  const r = triage({ title: 'urgent breach down', description: 'payment failed cannot login', category: 'security', affectedUsers: 100000 });
  assert.ok(r.score <= 100);
  assert.equal(r.score, 95);
});
