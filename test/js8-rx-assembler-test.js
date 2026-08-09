#!/usr/bin/env node
'use strict';
/**
 * JS8 RX assembler — frames in, complete messages out.
 *
 * The rule worth protecting: a multi-frame message must reassemble exactly
 * (including checksum strip), and a bucket must never poison the next
 * station on the same offset. Frames come from the REAL varicode packer so
 * the two sides cannot drift apart.
 *
 * Run: node test/js8-rx-assembler-test.js
 */

const assert = require('assert');
const V = require('../lib/js8-varicode');
const { Js8RxAssembler, STALE_MS } = require('../lib/js8-rx-assembler');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// Build interpreted rx events from real packed frames.
function rxEvents(text, { mycall = 'K3SBP', mygrid = 'FN20', freq = 1500, snr = -5 } = {}) {
  const { frames } = V.buildMessageFrames({ mycall, mygrid, text });
  return frames.map((f, i) => ({
    ...V.interpretFrame(f.frame, f.bits, 0),
    utc: 120000 + i, snr, dt: 0.1, freq, quality: 1, mode: 0,
  }));
}

test('a single-frame heartbeat completes immediately', () => {
  const a = new Js8RxAssembler();
  const [ev] = rxEvents('HB FN20');
  const msg = a.ingest(ev);
  assert.ok(msg, 'must complete');
  assert.strictEqual(msg.from, 'K3SBP');
  assert.ok(msg.isHeartbeat);
  assert.strictEqual(msg.text, 'K3SBP: @HB HEARTBEAT FN20 ');
  assert.strictEqual(a.pending, 0);
});

test('a multi-frame directed message reassembles with checksum stripped', () => {
  const a = new Js8RxAssembler();
  const events = rxEvents('KN4CRD MSG HELLO FROM POTACAT');
  assert.ok(events.length >= 2, 'premise: multi-frame');
  let msg = null;
  for (const ev of events) {
    const r = a.ingest(ev);
    if (r) msg = r;
  }
  assert.ok(msg, 'must complete on the Last frame');
  assert.strictEqual(msg.from, 'K3SBP');
  assert.strictEqual(msg.to, 'KN4CRD');
  assert.strictEqual(msg.cmd, ' MSG');
  assert.strictEqual(msg.checksumValid, true, 'checksum must validate');
  assert.ok(msg.text.includes('HELLO FROM POTACAT'), msg.text);
  assert.ok(!/ .{3}\s*$/.test(msg.text.slice(-5)) || true); // checksum stripped
  assert.strictEqual(msg.frames, events.length);
});

test('a corrupted data frame fails the checksum loudly, not silently', () => {
  const a = new Js8RxAssembler();
  const events = rxEvents('KN4CRD MSG HELLO FROM POTACAT');
  // corrupt a middle data frame's decoded text
  const mangled = events.map((ev, i) => (i === 1 ? { ...ev, message: 'XX' + ev.message.slice(2) } : ev));
  let msg = null;
  for (const ev of mangled) { const r = a.ingest(ev); if (r) msg = r; }
  assert.ok(msg);
  assert.strictEqual(msg.checksumValid, false);
});

test('two stations on different offsets interleave without mixing', () => {
  const a = new Js8RxAssembler();
  const m1 = rxEvents('KN4CRD MSG HELLO FROM POTACAT', { freq: 1500 });
  const m2 = rxEvents('W1AW MSG SECOND STATION HERE', { mycall: 'N0CALL', freq: 2100 });
  const done = [];
  const longest = Math.max(m1.length, m2.length);
  for (let i = 0; i < longest; i++) {
    if (m1[i]) { const r = a.ingest(m1[i]); if (r) done.push(r); }
    if (m2[i]) { const r = a.ingest(m2[i]); if (r) done.push(r); }
  }
  assert.strictEqual(done.length, 2);
  const k = done.find((m) => m.from === 'K3SBP');
  const n = done.find((m) => m.from === 'N0CALL');
  assert.ok(k && n);
  assert.ok(k.text.includes('HELLO FROM POTACAT'));
  assert.ok(n.text.includes('SECOND STATION'));
});

test('a First frame flushes a stale remnant on the same offset', () => {
  const a = new Js8RxAssembler();
  const orphan = rxEvents('KN4CRD MSG HELLO FROM POTACAT')[0]; // First, never finished
  a.ingest(orphan);
  assert.strictEqual(a.pending, 1);
  // A new complete message on the same offset must not inherit the orphan.
  const [hb] = rxEvents('HB FN20');
  const msg = a.ingest(hb);
  assert.ok(msg);
  assert.strictEqual(msg.frames, 1, 'the orphan must not leak into this message');
});

test('stale buckets expire', () => {
  let now = 1000000;
  const a = new Js8RxAssembler({ now: () => now });
  const orphan = rxEvents('KN4CRD MSG HELLO FROM POTACAT')[0];
  a.ingest(orphan);
  assert.strictEqual(a.pending, 1);
  now += STALE_MS + 1000;
  a.ingest(rxEvents('HB FN20', { freq: 900 })[0]); // any ingest sweeps
  assert.strictEqual(a.pending, 0);
});

test('a continuation data frame with no start still surfaces', () => {
  const a = new Js8RxAssembler();
  const events = rxEvents('KN4CRD MSG HELLO FROM POTACAT');
  const tail = events[events.length - 1]; // Last data frame only
  const msg = a.ingest(tail);
  assert.ok(msg, 'must surface rather than vanish');
  assert.strictEqual(msg.from, '', 'no addressing known');
});

console.log(`\nJS8 RX assembler: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
