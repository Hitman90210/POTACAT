#!/usr/bin/env node
'use strict';
/**
 * js8_native — the vendored JS8Call modem, all five submodes.
 *
 * The rule worth protecting: every submode's encoder output must decode in
 * the same submode's decoder. Only NORMAL is exposed in the UI today, but
 * the parameter table shipped complete from day one precisely so the other
 * four are a UI gate away — which is only true while this test holds. Each
 * case runs the REAL pipeline: encode -> continuous-phase audio -> ring ->
 * scheduler -> demod -> LDPC -> frame text.
 *
 * Skips (with a loud line) when the addon isn't built — CI builds it via
 * npm run build-js8; a dev box that never built it shouldn't hard-fail
 * unrelated work.
 *
 * Run: node test/js8-native-test.js
 */

const assert = require('assert');

let addon;
try {
  addon = require('../lib/js8_native/build/Release/js8_native.node');
} catch (e) {
  console.log('js8_native not built (npm run build-js8) — skipping native tests');
  process.exit(0);
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// Submode ids: Varicode::SubmodeType — the mask bit positions differ!
const SUBMODES = [
  { name: 'NORMAL', id: 0, bit: 1 << 0 },
  { name: 'FAST', id: 1, bit: 1 << 1 },
  { name: 'TURBO', id: 2, bit: 1 << 2 },
  { name: 'SLOW', id: 4, bit: 1 << 3 },
  { name: 'ULTRA', id: 8, bit: 1 << 4 },
];

test('submodeInfo knows all five submodes', () => {
  for (const s of SUBMODES) {
    const info = addon.submodeInfo(s.id);
    assert.ok(info.period > 0, s.name + ' period');
    assert.ok(info.samplesPerPeriod > 0, s.name + ' samplesPerPeriod');
    assert.ok(info.samplesNeeded <= info.samplesPerPeriod,
      s.name + ' needs no more than a period');
  }
  // The five periods are the protocol's: 15/10/6/30/4 seconds.
  assert.strictEqual(addon.submodeInfo(0).period, 15);
  assert.strictEqual(addon.submodeInfo(1).period, 10);
  assert.strictEqual(addon.submodeInfo(2).period, 6);
  assert.strictEqual(addon.submodeInfo(4).period, 30);
  assert.strictEqual(addon.submodeInfo(8).period, 4);
});

test('encode rejects a frame that is not exactly 12 chars', () => {
  assert.throws(() => addon.encode({ frame: 'SHORT', type: 0, submode: 0 }));
});

for (const s of SUBMODES) {
  test(`${s.name}: encode -> air -> decode round trip`, () => {
    const FRAME = 'POTACATJS8x0'; // alphabet72 chars only
    const info = addon.submodeInfo(s.id);
    const enc = addon.encode({
      frame: FRAME, type: 0, submode: s.id, freq: 1500, sampleRate: 12000,
    });
    assert.strictEqual(enc.tones.length, 79, 'always 79 symbols');

    addon.reset();
    const period = info.samplesPerPeriod;
    const delay = Math.round((info.startDelayMS / 1000) * 12000);
    const buf = new Float32Array(period);
    for (let i = 0; i < enc.audio.length && delay + i < period; i++) {
      buf[delay + i] = enc.audio[i] * 0.5;
    }
    for (let i = 0; i < buf.length; i++) buf[i] += (Math.random() - 0.5) * 0.02;

    // Stream with decode ticks so the per-submode scheduler sees k grow.
    let decodes = [];
    const CHUNK = 3000;
    for (let off = 0; off < buf.length; off += CHUNK) {
      addon.appendAudio(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
      const r = addon.decode({
        submodes: s.bit, nfa: 500, nfb: 2700, nfqso: 1500, utc: 0,
      });
      decodes = decodes.concat(r.decodes);
    }
    assert.ok(decodes.length > 0, 'no decode for ' + s.name);
    assert.strictEqual(decodes[0].text, FRAME, s.name + ' frame text');
    assert.strictEqual(decodes[0].mode, s.id, s.name + ' mode tag');
  });
}

test('the itype rides through intact', () => {
  // 3 = First|Last — the flags the varicode layer needs to reassemble.
  const FRAME = 'abcdefghijk9';
  addon.reset();
  const enc = addon.encode({ frame: FRAME, type: 3, submode: 0, freq: 1200, sampleRate: 12000 });
  const buf = new Float32Array(15 * 12000);
  for (let i = 0; i < enc.audio.length; i++) buf[6000 + i] = enc.audio[i] * 0.5;
  for (let i = 0; i < buf.length; i++) buf[i] += (Math.random() - 0.5) * 0.02;
  let decodes = [];
  for (let off = 0; off < buf.length; off += 3000) {
    addon.appendAudio(buf.subarray(off, Math.min(off + 3000, buf.length)));
    decodes = decodes.concat(addon.decode({ submodes: 1, nfa: 500, nfb: 2700, nfqso: 1200, utc: 0 }).decodes);
  }
  assert.ok(decodes.length > 0);
  assert.strictEqual(decodes[0].type, 3);
  assert.strictEqual(decodes[0].text, FRAME);
});

console.log(`\nJS8 native: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
