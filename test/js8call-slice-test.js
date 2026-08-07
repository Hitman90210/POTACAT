#!/usr/bin/env node
'use strict';
/**
 * Giving JS8Call its own slice on a multi-slice Flex.
 *
 * The rule these tests protect: a DAX channel is only usable if a slice feeds
 * it. K3SBP's station spent an evening on this — one slice bound to DAX 1,
 * JS8Call pointed at DAX 2, a device that opened perfectly and delivered
 * silence, and nothing anywhere reporting a problem.
 *
 * Run: node test/js8call-slice-test.js
 */

const assert = require('assert');
const {
  freeDaxChannel, canCreateSlice, js8SliceFreq, bandForHz, planJs8Slice, JS8_MODE,
} = require('../lib/js8call-slice');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ── choosing a channel ───────────────────────────────────────────────────────

test('the first channel with nothing bound to it wins', () => {
  assert.strictEqual(freeDaxChannel([1]), 2);
  assert.strictEqual(freeDaxChannel([]), 1);
  assert.strictEqual(freeDaxChannel([1, 2, 3]), 4);
});

test('channel 0 is "off", never a target', () => {
  // A slice reporting dax=0 is bound to nothing; it must not make channel 0
  // look busy, and must never be handed out as a destination.
  assert.strictEqual(freeDaxChannel([0]), 1);
});

test('a radio with every channel bound has none free', () => {
  assert.strictEqual(freeDaxChannel([1, 2, 3, 4, 5, 6, 7, 8]), null);
});

// ── may we create one ────────────────────────────────────────────────────────

test('a free slice and a free channel is a yes', () => {
  const r = canCreateSlice({ slices: [0], maxSlices: 4, usedDax: [1] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.daxChannel, 2);
});

test('a full radio is refused, and says so in numbers', () => {
  const r = canCreateSlice({ slices: [0, 1, 2, 3], maxSlices: 4, usedDax: [1] });
  assert.strictEqual(r.ok, false);
  assert.ok(/all 4 of its slices/.test(r.reason), r.reason);
});

test('not controlling the radio is a different refusal', () => {
  // "No free slice" and "we do not control the radio" send the operator to
  // completely different places; a bare false sends them to the wrong one.
  const r = canCreateSlice({ slices: [], canControl: false });
  assert.strictEqual(r.ok, false);
  assert.ok(/not controlling/.test(r.reason), r.reason);
  assert.notStrictEqual(r.reason, canCreateSlice({ slices: [0, 1, 2, 3] }).reason);
});

test('slices free but every DAX channel bound is still a no', () => {
  const r = canCreateSlice({ slices: [0], maxSlices: 4, usedDax: [1, 2, 3, 4, 5, 6, 7, 8] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.daxChannel, null);
});

// ── where to put it ──────────────────────────────────────────────────────────

test('the new slice lands on the JS8 dial for the band already in use', () => {
  assert.strictEqual(js8SliceFreq(14_074_000), 14.078);
  assert.strictEqual(js8SliceFreq(7_035_000), 7.078);
  assert.strictEqual(js8SliceFreq(10_136_000), 10.130);
});

test('an unknown or out-of-band frequency falls back to 20 m', () => {
  assert.strictEqual(js8SliceFreq(0), 14.078);
  assert.strictEqual(js8SliceFreq(462_000_000), 14.078);
});

test('band lookup covers the HF bands and refuses the gaps', () => {
  assert.strictEqual(bandForHz(14_200_000), 20);
  assert.strictEqual(bandForHz(50_313_000), 6);
  assert.strictEqual(bandForHz(12_000_000), null, 'between bands is not a band');
});

// ── the whole plan ───────────────────────────────────────────────────────────

test('the plan is data, and it is shown before anything is sent', () => {
  const p = planJs8Slice({ slices: [0], usedDax: [1], currentHz: 14_074_000 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.daxChannel, 2);
  assert.strictEqual(p.freq, 14.078);
  assert.strictEqual(p.mode, JS8_MODE, 'JS8 is DIGU on a Flex, not plain USB');
  assert.strictEqual(p.steps.length, 3);
  assert.ok(/14\.078 MHz DIGU/.test(p.steps[0]), p.steps[0]);
  assert.ok(/DAX channel 2/.test(p.steps[1]), p.steps[1]);
});

test('a refused plan carries the reason and no half-built instructions', () => {
  const p = planJs8Slice({ slices: [0, 1, 2, 3], usedDax: [1] });
  assert.strictEqual(p.ok, false);
  assert.ok(p.reason);
  assert.strictEqual(p.steps, undefined, 'nothing to execute means nothing to display');
});

console.log(`\nJS8Call slice: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
