#!/usr/bin/env node
'use strict';
/**
 * JS8 over ECHOCAT — the server half of the phone data path.
 *
 * The rules worth protecting: an owner's messages emit VERBATIM to main
 * (the host owns composition — a server that shapes text breaks
 * addressing); a Guest Pass session can browse but never key or configure
 * the transmitter, and every refusal answers on js8-send-result so the
 * guest UI shows why; hydration replays cached state so a suspended phone
 * reconnects to the inbox as it stands.
 *
 * Harness: drive _handleMessage with a stubbed socket, no network — the
 * same pattern as diagnostic-snapshot-test.js.
 *
 * Run: node test/js8-remote-test.js
 */

const assert = require('assert');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function fakeWs() {
  const sent = [];
  return {
    _authenticated: true,
    readyState: 1,
    send: (w) => { try { sent.push(JSON.parse(w)); } catch {} },
    _sent: sent,
  };
}

// ── registry ─────────────────────────────────────────────────────────────────

test('every JS8 message is registered with the right direction', () => {
  for (const t of ['js8-start', 'js8-stop', 'js8-heartbeat', 'js8-send',
    'js8-thread-open', 'js8-thread-closed']) {
    assert.ok(protocol.isKnownType(t), t + ' missing from registry');
    assert.strictEqual(protocol.describe(t).dir, protocol.Dir.C2S, t + ' direction');
  }
  for (const t of ['js8-state', 'js8-threads', 'js8-heard', 'js8-thread',
    'js8-send-result']) {
    assert.ok(protocol.isKnownType(t), t + ' missing from registry');
    assert.strictEqual(protocol.describe(t).dir, protocol.Dir.S2C, t + ' direction');
  }
});

test('the server hello advertises the js8 capability', () => {
  const hello = protocol.buildServerHello({ capabilities: ['js8'] });
  assert.ok(hello.capabilities.includes('js8'));
});

test('js8-send validates with and without optional fields', () => {
  assert.ok(protocol.validate({ type: 'js8-send', text: 'SNR?' }, protocol.Dir.C2S).ok);
  assert.ok(protocol.validate({ type: 'js8-send', text: 'SNR?', to: 'KN4CRD', reqId: 'm1' }, protocol.Dir.C2S).ok);
  assert.ok(!protocol.validate({ type: 'js8-send' }, protocol.Dir.C2S).ok, 'text is required');
});

// ── owner path: emits verbatim ───────────────────────────────────────────────

test('an owner send emits text/to/reqId untouched', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const events = [];
  rs.on('js8-send', (e) => events.push(e));
  rs._handleMessage(ws, { type: 'js8-send', text: '  spaced text ', to: '@ALLCALL', reqId: 'r7' }, {});
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0], { text: '  spaced text ', to: '@ALLCALL', reqId: 'r7' },
    'no trimming, no shaping — the host owns composition');
  assert.strictEqual(ws._sent.length, 0, 'no immediate reply; main answers via sendJs8SendResult');
});

test('owner lifecycle + heartbeat + thread messages all emit', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const seen = [];
  for (const t of ['js8-start', 'js8-stop', 'js8-heartbeat', 'js8-thread-open', 'js8-thread-closed']) {
    rs.on(t, (e) => seen.push([t, e]));
  }
  rs._handleMessage(ws, { type: 'js8-start' }, {});
  rs._handleMessage(ws, { type: 'js8-heartbeat', enabled: true, intervalMin: 30 }, {});
  rs._handleMessage(ws, { type: 'js8-thread-open', id: 'KN4CRD' }, {});
  rs._handleMessage(ws, { type: 'js8-thread-closed' }, {});
  rs._handleMessage(ws, { type: 'js8-stop' }, {});
  assert.strictEqual(seen.length, 5);
  assert.deepStrictEqual(seen[1][1], { enabled: true, intervalMin: 30 });
  assert.deepStrictEqual(seen[2][1], { id: 'KN4CRD' });
});

// ── guest path: browse yes, transmit no ─────────────────────────────────────

test('a guest send is refused on js8-send-result with the reqId', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  ws._passSession = { code: 'GUEST1' };
  rs._client = ws;
  let emitted = 0;
  rs.on('js8-send', () => { emitted++; });
  rs._handleMessage(ws, { type: 'js8-send', text: 'CQ CQ CQ', reqId: 'g1' }, {});
  assert.strictEqual(emitted, 0, 'guest send must NOT reach main');
  assert.strictEqual(ws._sent.length, 1, 'guest gets an immediate reply');
  assert.strictEqual(ws._sent[0].type, 'js8-send-result');
  assert.strictEqual(ws._sent[0].ok, false);
  assert.ok(ws._sent[0].error, 'refusal carries a reason');
  assert.strictEqual(ws._sent[0].reqId, 'g1', 'reply matches the tap');
});

test('guest start/stop/heartbeat are refused; thread browsing is not', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  ws._passSession = { code: 'GUEST1' };
  rs._client = ws;
  const emits = { start: 0, stop: 0, hb: 0, open: 0 };
  rs.on('js8-start', () => { emits.start++; });
  rs.on('js8-stop', () => { emits.stop++; });
  rs.on('js8-heartbeat', () => { emits.hb++; });
  rs.on('js8-thread-open', () => { emits.open++; });
  rs._handleMessage(ws, { type: 'js8-start' }, {});
  rs._handleMessage(ws, { type: 'js8-stop' }, {});
  rs._handleMessage(ws, { type: 'js8-heartbeat', enabled: true }, {});
  rs._handleMessage(ws, { type: 'js8-thread-open', id: 'W1AW' }, {});
  assert.deepStrictEqual(emits, { start: 0, stop: 0, hb: 0, open: 1 },
    'lifecycle refused, read-only browsing allowed');
  const refusals = ws._sent.filter((m) => m.type === 'js8-send-result' && m.ok === false);
  assert.strictEqual(refusals.length, 3, 'each refused message answers');
});

// ── broadcasts: cache for hydration ─────────────────────────────────────────

test('state/threads/heard broadcasts cache, and threads drops the delta', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  rs.broadcastJs8State({ running: true, tx: false, txQueue: 0, submode: 'NORMAL', heartbeat: false, heartbeatMin: 15, station: { call: 'K3SBP', grid: 'FN20' } });
  rs.broadcastJs8Threads({ list: [{ id: 'KN4CRD' }], unread: 2, changed: 'KN4CRD', thread: { id: 'KN4CRD', messages: [] } });
  rs.broadcastJs8Heard([{ call: 'W1AW', snr: -8, utc: 1, grid: '' }]);

  assert.strictEqual(rs._js8State.running, true);
  // The hydration cache holds STATE, not the moment's delta — a phone that
  // reconnects an hour later must not get a stale "this one just changed".
  assert.deepStrictEqual(rs._js8Threads, { list: [{ id: 'KN4CRD' }], unread: 2 });
  assert.strictEqual(rs._js8Heard.length, 1);

  // The live client saw all three, delta included.
  const types = ws._sent.map((m) => m.type);
  assert.deepStrictEqual(types, ['js8-state', 'js8-threads', 'js8-heard']);
  assert.strictEqual(ws._sent[1].changed, 'KN4CRD');
});

test('sendJs8Thread and sendJs8SendResult reach the live client', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  rs.sendJs8Thread({ id: 'KN4CRD', messages: [] });
  rs.sendJs8SendResult({ ok: true, text: 'KN4CRD: SNR? ', frames: 1, reqId: 'm1' });
  assert.strictEqual(ws._sent[0].type, 'js8-thread');
  assert.strictEqual(ws._sent[1].type, 'js8-send-result');
  assert.strictEqual(ws._sent[1].frames, 1);
});

console.log(`\nJS8 remote: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
