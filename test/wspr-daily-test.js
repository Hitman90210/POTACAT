#!/usr/bin/env node
'use strict';
/**
 * WSPR daily rollup — counts that stay honest.
 *
 * The rules worth protecting: decodes and uploads fold into the right UTC
 * day; the rollover fires exactly once so the summary line can't spam or
 * vanish; and the wsprnet/PSKReporter counters keep their distinct
 * meanings — accepted vs sent — because UDP has no ack and the numbers
 * must never claim otherwise.
 *
 * Run: node test/wspr-daily-test.js
 */

const assert = require('assert');
const { fold, summarize, todayPayload, dayKey } = require('../lib/wspr/daily');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const DAY1 = Date.UTC(2026, 7, 9, 23, 50, 0);
const DAY2 = Date.UTC(2026, 7, 10, 0, 4, 0);

test('decodes fold into the UTC day with dedup and best-DX tracking', () => {
  let r = fold(null, { nowMs: DAY1, spots: [
    { call: 'W1AW', distanceMi: 210 },
    { call: 'G4ABC', distanceMi: 3400 },
  ] });
  r = fold(r.state, { nowMs: DAY1 + 120000, spots: [
    { call: 'W1AW', distanceMi: 215 },   // same call again — unique stays 2
    { call: 'VK2DEF', distanceMi: 9900 },
  ] });
  assert.strictEqual(r.day.decoded, 4);
  assert.strictEqual(r.day.calls.length, 3);
  assert.strictEqual(r.day.bestDxMi, 9900);
  assert.strictEqual(r.day.bestDxCall, 'VK2DEF');
  assert.strictEqual(r.day.batches, 2);
});

test('upload counters keep their distinct meanings', () => {
  let r = fold(null, { nowMs: DAY1, spots: [{ call: 'W1AW' }] });
  r = fold(r.state, { nowMs: DAY1, uploadedWsprnet: 1 });
  r = fold(r.state, { nowMs: DAY1, sentPskr: 1 });
  assert.strictEqual(r.day.uploadedWsprnet, 1);
  assert.strictEqual(r.day.sentPskr, 1);
  const line = summarize(r.day);
  assert.ok(line.includes('accepted by wsprnet'), line);
  assert.ok(line.includes('sent to PSKReporter'), line);
  assert.ok(!/received by PSKReporter/i.test(line), 'UDP has no ack — never claim receipt');
});

test('UTC midnight rolls the day over exactly once', () => {
  let r = fold(null, { nowMs: DAY1, spots: [{ call: 'W1AW' }] });
  r = fold(r.state, { nowMs: DAY2, spots: [{ call: 'G4ABC' }] });
  assert.ok(r.rolledOver, 'the finished day surfaces at the first new-day event');
  assert.strictEqual(r.rolledOver.date, dayKey(DAY1));
  assert.strictEqual(r.rolledOver.decoded, 1);
  const again = fold(r.state, { nowMs: DAY2 + 120000, spots: [{ call: 'VK2DEF' }] });
  assert.strictEqual(again.rolledOver, null, 'only once — the summary line must not spam');
  assert.strictEqual(again.day.decoded, 2);
});

test('both days survive in history after rollover', () => {
  let r = fold(null, { nowMs: DAY1, spots: [{ call: 'W1AW' }] });
  r = fold(r.state, { nowMs: DAY2, spots: [{ call: 'G4ABC' }] });
  assert.ok(r.state.days[dayKey(DAY1)]);
  assert.ok(r.state.days[dayKey(DAY2)]);
});

test('todayPayload is the compact wire shape', () => {
  const r = fold(null, { nowMs: DAY1, spots: [{ call: 'W1AW', distanceMi: 210 }], });
  const p = todayPayload(r.day);
  assert.deepStrictEqual(Object.keys(p).sort(),
    ['bestDxCall', 'bestDxMi', 'date', 'decoded', 'sentPskr', 'uniqueCalls', 'uploadedWsprnet']);
  assert.strictEqual(p.uniqueCalls, 1);
});

test('an empty day summarizes without inventing numbers', () => {
  assert.ok(/no decodes/.test(summarize(null)));
});

console.log(`\nWSPR daily: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
