'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker } = require('../src/modules/notifier/circuitBreaker');
const { Notifier } = require('../src/modules/notifier/notifier');
const { makeClock } = require('./helpers');

const ok = async () => 'fine';
const bad = async () => { throw new Error('boom'); };

function make() {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetMs: 20000, now: clock.now });
  return { clock, breaker };
}

test('stays CLOSED below the failure threshold and resets the counter on success', async () => {
  const { breaker } = make();
  await breaker.exec(bad); await breaker.exec(bad);
  assert.equal(breaker.snapshot().state, 'CLOSED');
  assert.equal(breaker.snapshot().consecutiveFailures, 2);
  await breaker.exec(ok);
  assert.equal(breaker.snapshot().consecutiveFailures, 0);
});

test('opens after 3 consecutive failures and then fails fast without calling the function', async () => {
  const { breaker } = make();
  for (let i = 0; i < 3; i++) await breaker.exec(bad);
  assert.equal(breaker.snapshot().state, 'OPEN');
  let called = false;
  const r = await breaker.exec(async () => { called = true; });
  assert.equal(called, false);
  assert.deepEqual([r.ok, r.reason], [false, 'CIRCUIT_OPEN']);
});

test('becomes HALF_OPEN after 20 seconds; a successful trial closes it', async () => {
  const { breaker, clock } = make();
  for (let i = 0; i < 3; i++) await breaker.exec(bad);
  clock.advance(19999);
  assert.equal(breaker.snapshot().state, 'OPEN');
  clock.advance(1);
  assert.equal(breaker.snapshot().state, 'HALF_OPEN');
  const r = await breaker.exec(ok);
  assert.equal(r.ok, true);
  assert.equal(breaker.snapshot().state, 'CLOSED');
});

test('a failed trial in HALF_OPEN re-opens the breaker', async () => {
  const { breaker, clock } = make();
  for (let i = 0; i < 3; i++) await breaker.exec(bad);
  clock.advance(20000);
  await breaker.exec(bad);
  assert.equal(breaker.snapshot().state, 'OPEN');
});

test('HALF_OPEN allows only one trial call at a time', async () => {
  const { breaker, clock } = make();
  for (let i = 0; i < 3; i++) await breaker.exec(bad);
  clock.advance(20000);
  let release;
  const slow = breaker.exec(() => new Promise((res) => { release = res; }));
  const second = await breaker.exec(ok);
  assert.deepEqual([second.ok, second.reason], [false, 'CIRCUIT_OPEN']);
  release();
  assert.equal((await slow).ok, true);
});

test('notifier queues while failing and flushes the queue once the breaker closes', async () => {
  const { breaker, clock } = make();
  const delivered = [];
  const n = new Notifier({ breaker, latencyMs: 0, onDeliveredFromQueue: (id) => delivered.push(id) });
  n.setMode('failing');
  assert.equal(await n.notify('tkt_1'), 'queued');
  assert.equal(await n.notify('tkt_2'), 'queued');
  assert.equal(await n.notify('tkt_3'), 'queued'); // third failure opens the breaker
  assert.equal(breaker.snapshot().state, 'OPEN');
  const attempts = n.attempts;
  assert.equal(await n.notify('tkt_4'), 'queued'); // fail fast: no new attempt
  assert.equal(n.attempts, attempts);
  assert.equal(n.queue.length, 4);

  n.setMode('healthy');
  clock.advance(20000);
  assert.equal(await n.notify('tkt_5'), 'sent'); // trial succeeds, breaker closes, queue flushes
  await n.whenIdle();
  assert.equal(breaker.snapshot().state, 'CLOSED');
  assert.deepEqual(delivered, ['tkt_1', 'tkt_2', 'tkt_3', 'tkt_4']);
  assert.equal(n.queue.length, 0);
});
