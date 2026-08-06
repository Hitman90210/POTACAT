#!/usr/bin/env node
'use strict';
/**
 * JS8Call TCP API client — parsing, TX-state detection, and real socket
 * behaviour against a fake server.
 *
 * The TX-state tests carry the weight here. If POTACAT misses a JS8Call
 * key-down it can transmit on top, and on a Flex that re-points `tx=1` and puts
 * JS8Call's audio out on POTACAT's slice and frequency — off-frequency
 * transmission with no error anywhere. JS8Call also keys unprompted (heartbeat
 * auto-reply is a feature of the mode, not a misconfiguration), so this is the
 * normal case rather than an edge one.
 *
 * Run: node test/js8call-client-test.js
 */

const assert = require('assert');
const net = require('net');
const {
  Js8CallClient, parseJs8Message, txStateFromMessage, isDirectedTo,
  DEFAULT_PORT, RECONNECT_MIN_MS,
} = require('../lib/js8call-client');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function asyncTest(name, fn) { pending.push({ name, fn }); }

// ── parsing ──────────────────────────────────────────────────────────────────

test('parses a real RX.DIRECTED frame', () => {
  const m = parseJs8Message('{"type":"RX.DIRECTED","value":"KN4CRD: K3SBP HELLO","params":{"FROM":"KN4CRD","TO":"K3SBP","SNR":-7,"DIAL":14078000}}');
  assert.strictEqual(m.type, 'RX.DIRECTED');
  assert.strictEqual(m.value, 'KN4CRD: K3SBP HELLO');
  assert.strictEqual(m.params.FROM, 'KN4CRD');
  assert.strictEqual(m.params.SNR, -7);
});

test('missing value/params default rather than throw', () => {
  const m = parseJs8Message('{"type":"PING"}');
  assert.deepStrictEqual(m, { type: 'PING', value: '', params: {} });
});

test('non-JSON and malformed lines are inert, never fatal', () => {
  // A fork printing a banner, a partial flush, or a log line must not kill the
  // connection — an unknown line is simply not a message.
  for (const bad of ['', '   ', 'JS8Call v2.4.0', '{not json', '[]', 'null', '{"value":"no type"}', '{"type":42}']) {
    assert.strictEqual(parseJs8Message(bad), null, JSON.stringify(bad));
  }
});

test('isDirectedTo splits traffic from traffic for you', () => {
  const m = parseJs8Message('{"type":"RX.DIRECTED","params":{"TO":"K3SBP"}}');
  assert.strictEqual(isDirectedTo(m, 'K3SBP'), true);
  assert.strictEqual(isDirectedTo(m, 'k3sbp'), true, 'case-insensitive');
  assert.strictEqual(isDirectedTo(m, 'W1AW'), false);
  assert.strictEqual(isDirectedTo(m, ''), false);
  assert.strictEqual(isDirectedTo(null, 'K3SBP'), false);
});

// ── TX state ─────────────────────────────────────────────────────────────────

test('RIG.PTT reports key-down and key-up', () => {
  assert.strictEqual(txStateFromMessage(parseJs8Message('{"type":"RIG.PTT","params":{"PTT":true}}')), true);
  assert.strictEqual(txStateFromMessage(parseJs8Message('{"type":"RIG.PTT","params":{"PTT":false}}')), false);
});

test('RIG.PTT accepts the shapes different builds send', () => {
  // Version and fork dependent: booleans, 1/0, and "true"/"on" all appear.
  for (const v of ['true', '"true"', '1', '"on"', '"YES"']) {
    assert.strictEqual(
      txStateFromMessage(parseJs8Message(`{"type":"RIG.PTT","params":{"PTT":${v}}}`)), true, v);
  }
  for (const v of ['false', '"false"', '0', '"off"', '""']) {
    assert.strictEqual(
      txStateFromMessage(parseJs8Message(`{"type":"RIG.PTT","params":{"PTT":${v}}}`)), false, v);
  }
  assert.strictEqual(
    txStateFromMessage(parseJs8Message('{"type":"RIG.PTT","params":{"VALUE":true}}')), true,
    'VALUE is the alternate key name');
});

test('TX.FRAME means transmitting even without a PTT event', () => {
  assert.strictEqual(txStateFromMessage(parseJs8Message('{"type":"TX.FRAME","value":"K3SBP: HB"}')), true);
  assert.strictEqual(txStateFromMessage(parseJs8Message('{"type":"TX.SENDING"}')), true);
});

test('STATION.STATUS reports TX only when it says so explicitly', () => {
  assert.strictEqual(txStateFromMessage(parseJs8Message('{"type":"STATION.STATUS","params":{"PTT":true}}')), true);
  assert.strictEqual(txStateFromMessage(parseJs8Message('{"type":"STATION.STATUS","params":{"TRANSMITTING":false}}')), false);
  assert.strictEqual(txStateFromMessage(parseJs8Message('{"type":"STATION.STATUS","params":{"DIAL":14078000}}')), null,
    'silence about TX is not a claim that it is idle');
});

test('ordinary receive traffic says nothing about TX', () => {
  for (const t of ['RX.DIRECTED', 'RX.ACTIVITY', 'RX.SPOT', 'PING', 'MODE.SPEED', 'ANYTHING.NEW']) {
    assert.strictEqual(txStateFromMessage(parseJs8Message(`{"type":"${t}"}`)), null, t);
  }
  assert.strictEqual(txStateFromMessage(null), null);
});

// ── socket behaviour ─────────────────────────────────────────────────────────

function fakeServer(onConn) {
  const srv = net.createServer(onConn);
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv)));
}
const port = (srv) => srv.address().port;

asyncTest('connects, parses a stream, and reports status', async () => {
  const srv = await fakeServer((sock) => {
    // Two messages in one packet, plus a split third — the framing must not
    // care where TCP happened to break.
    sock.write('{"type":"PING"}\n{"type":"RX.ACTIVITY","value":"a"}\n{"type":"RX.DIR');
    setTimeout(() => sock.write('ECTED","params":{"TO":"K3SBP"}}\n'), 20);
  });
  const c = new Js8CallClient();
  const seen = [];
  let up = false;
  c.on('message', (m) => seen.push(m.type));
  c.on('status', (s) => { if (s.connected) up = true; });
  c.connect({ port: port(srv) });
  await wait(150);
  assert.strictEqual(up, true, 'status reported');
  assert.deepStrictEqual(seen, ['PING', 'RX.ACTIVITY', 'RX.DIRECTED'], seen.join(','));
  c.disconnect(); srv.close();
});

asyncTest('emits tx true/false and only on change', async () => {
  const srv = await fakeServer((sock) => {
    sock.write('{"type":"RIG.PTT","params":{"PTT":true}}\n');
    sock.write('{"type":"TX.FRAME"}\n');                       // still transmitting
    setTimeout(() => sock.write('{"type":"RIG.PTT","params":{"PTT":false}}\n'), 20);
  });
  const c = new Js8CallClient();
  const tx = [];
  c.on('tx', (v) => tx.push(v));
  c.connect({ port: port(srv) });
  await wait(150);
  assert.deepStrictEqual(tx, [true, false], 'no duplicate key-down from TX.FRAME');
  assert.strictEqual(c.transmitting, false);
  c.disconnect(); srv.close();
});

asyncTest('a drop while keyed releases TX — a lost socket must not deadlock POTACAT', async () => {
  const srv = await fakeServer((sock) => {
    sock.write('{"type":"RIG.PTT","params":{"PTT":true}}\n');
    setTimeout(() => sock.destroy(), 30);
  });
  const c = new Js8CallClient();
  const tx = [];
  c.on('tx', (v) => tx.push(v));
  c.connect({ port: port(srv) });
  await wait(150);
  assert.deepStrictEqual(tx, [true, false], 'key-up synthesised on drop');
  assert.strictEqual(c.transmitting, false);
  c.disconnect(); srv.close();
});

asyncTest('send() writes a well-formed command and no-ops when down', async () => {
  let got = '';
  const srv = await fakeServer((sock) => { sock.on('data', (d) => { got += d.toString(); }); });
  const c = new Js8CallClient();
  assert.strictEqual(c.send({ type: 'X' }), false, 'no-op before connect');
  c.connect({ port: port(srv) });
  await wait(60);
  c.sendMessage('  HELLO  ');
  assert.strictEqual(c.sendMessage('   '), false, 'blank text is refused');
  await wait(40);
  const line = JSON.parse(got.trim());
  assert.deepStrictEqual(line, { type: 'TX.SEND_MESSAGE', value: 'HELLO', params: {} });
  c.disconnect(); srv.close();
});

asyncTest('disconnect is intent: no reconnect follows', async () => {
  let conns = 0;
  const srv = await fakeServer(() => { conns++; });
  const c = new Js8CallClient();
  c.connect({ port: port(srv) });
  await wait(60);
  assert.strictEqual(conns, 1);
  c.disconnect();
  await wait(RECONNECT_MIN_MS + 400);
  assert.strictEqual(conns, 1, 'operator disconnect is not undone by a queued reconnect');
  srv.close();
});

asyncTest('a refused port retries with backoff instead of hammering', async () => {
  // Nothing listening — the shape of "JS8Call is not running" or "its API
  // checkbox is off", which is the normal first-run state.
  const c = new Js8CallClient();
  let statuses = 0;
  c.on('status', () => { statuses++; });
  c.connect({ port: 1 });                 // reserved, always refused
  await wait(400);
  assert.strictEqual(c.connected, false);
  assert.strictEqual(statuses, 0, 'never reported connected');
  c.disconnect();
});

asyncTest('a stale socket cannot corrupt live state', async () => {
  const srv = await fakeServer((sock) => { sock.write('{"type":"PING"}\n'); });
  const c = new Js8CallClient();
  c.connect({ port: port(srv) });
  await wait(60);
  const stale = c._sock;
  c.disconnect();                          // _sock becomes null
  stale.emit('data', Buffer.from('{"type":"RIG.PTT","params":{"PTT":true}}\n'));
  stale.emit('close');
  assert.strictEqual(c.transmitting, false, 'late callback from a dead socket ignored');
  assert.strictEqual(c.connected, false);
  srv.close();
});

asyncTest('an over-long unterminated line resets rather than growing forever', async () => {
  const srv = await fakeServer((sock) => {
    sock.write('{"type":"X","value":"' + 'z'.repeat(5 * 1024 * 1024) + '');
    setTimeout(() => sock.write('\n{"type":"PING"}\n'), 40);
  });
  const c = new Js8CallClient();
  const seen = [];
  let logged = false;
  c.on('message', (m) => seen.push(m.type));
  c.on('log', (l) => { if (/buffer reset/.test(l)) logged = true; });
  c.connect({ port: port(srv) });
  await wait(300);
  assert.strictEqual(logged, true, 'said why');
  assert.ok(!seen.includes('X'), 'the oversized frame was dropped');
  c.disconnect(); srv.close();
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('\n=== JS8Call client ===');
  for (const { name, fn } of pending) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log(`\nJS8Call client: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
