#!/usr/bin/env node
'use strict';
/**
 * Js8Engine — the Ft8Engine-contract sibling that makes JS8 a native JTCAT
 * mode.
 *
 * The rule worth protecting: the ENTIRE station loop must close inside the
 * engine — text in, tx-start audio out, that audio fed back as RX, the
 * message re-assembled from js8-rx events. That is what "no JS8Call app,
 * no cable" actually claims, so it is what the test proves. Everything
 * runs through the real worker (real modem, real varicode).
 *
 * Run: node test/js8-engine-test.js
 */

const assert = require('assert');
const { Js8Engine, SUBMODES } = require('../lib/js8-engine');
const { JtcatManager } = require('../lib/jtcat-manager');
const V = require('../lib/js8-varicode');

let pass = 0, fail = 0;
const failures = [];
function report(name, err) {
  if (err) { fail++; failures.push(name + ': ' + (err.message || err)); console.log('  FAIL ' + name); }
  else { pass++; console.log('  ok  ' + name); }
}

function waitFor(emitter, event, timeoutMs, filter) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, on);
      reject(new Error(`timeout waiting for '${event}'`));
    }, timeoutMs);
    function on(data) {
      if (filter && !filter(data)) return;
      clearTimeout(timer);
      emitter.removeListener(event, on);
      resolve(data);
    }
    emitter.on(event, on);
  });
}

async function main() {
  // ── contract shape ─────────────────────────────────────────────────────────
  try {
    const e = new Js8Engine();
    for (const f of ['_running', '_txEnabled', '_txActive', '_txFreq', '_rxFreq', '_mode', '_txMessage']) {
      assert.ok(f in e, 'missing contract field ' + f);
    }
    for (const m of ['start', 'stop', 'feedAudio', 'txComplete', 'tryImmediateTx',
      'setMode', 'setTxSlot', 'setHoldTxFreq', 'setLateStartTx', 'setApContext',
      'setAudioLatencyMs', 'setWsprDial', 'reBaseline', 'encodeMessage']) {
      assert.strictEqual(typeof e[m], 'function', 'missing contract method ' + m);
    }
    assert.strictEqual(e._mode, 'JS8');
    report('the Ft8Engine contract surface is complete');
  } catch (err) { report('the Ft8Engine contract surface is complete', err); }

  // ── manager hosting ────────────────────────────────────────────────────────
  let manager = null;
  try {
    manager = new JtcatManager();
    const engine = manager.startSlice({
      sliceId: 'default', mode: 'JS8', submode: 'NORMAL',
      myCall: 'K3SBP', myGrid: 'FN20',
    });
    assert.ok(engine instanceof Js8Engine, 'startSlice must build a Js8Engine for JS8');
    assert.strictEqual(engine._myCall, 'K3SBP');
    assert.strictEqual(engine._running, true);
    report('jtcat-manager hosts JS8 as its own engine class');
  } catch (err) { report('jtcat-manager hosts JS8 as its own engine class', err); }

  const engine = manager.getEngine('default');

  // Wait for the worker to come up.
  try {
    const deadline = Date.now() + 10000;
    while (!engine._workerReady && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(engine._workerReady, 'worker must become ready');
    report('the decode worker starts');
  } catch (err) { report('the decode worker starts', err); }

  // ── TX: text becomes period-aligned audio ─────────────────────────────────
  let txData = null;
  try {
    const n = engine.setTxText('KN4CRD SNR?');
    assert.strictEqual(n, 1, 'one directed frame');
    engine._txEnabled = true;
    // The slot clock fires within one 15 s period; the frame renders first.
    txData = await waitFor(manager, 'tx-start', 20000);
    assert.ok(txData.samples instanceof Float32Array, 'samples must be Float32Array');
    assert.ok(txData.samples.length > 12000, 'audio must be substantial');
    assert.strictEqual(txData.freq, 1500);
    assert.strictEqual(txData.framesLeft, 0);
    report('armed TX fires at a period boundary with the dispatch payload');
  } catch (err) { report('armed TX fires at a period boundary with the dispatch payload', err); }

  // ── the loop closes: our own TX audio decodes back into the message ───────
  try {
    assert.ok(txData, 'needs the TX audio from the previous test');
    // Simulate playback completion so the engine returns to RX.
    engine.txComplete();
    assert.strictEqual(engine._txActive, false);

    // Feed the transmission back as received audio, positioned like a real
    // period: half a second of silence, the signal, noise fill.
    const period = SUBMODES.NORMAL.period * 12000;
    const buf = new Float32Array(period);
    const delay = 6000;
    for (let i = 0; i < txData.samples.length && delay + i < buf.length; i++) {
      buf[delay + i] = txData.samples[i] * 0.5;
    }
    for (let i = 0; i < buf.length; i++) buf[i] += (Math.random() - 0.5) * 0.02;

    const rxPromise = waitFor(manager, 'js8-rx', 30000);
    const CHUNK = 3000;
    for (let off = 0; off < buf.length; off += CHUNK) {
      engine.feedAudio(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
      await new Promise((r) => setTimeout(r, 5));
    }
    const rx = await rxPromise;
    assert.strictEqual(rx.frameTypeString, 'directed');
    assert.strictEqual(rx.message, 'K3SBP: KN4CRD SNR? ');
    assert.ok(rx.isFirst && rx.isLast, 'single-frame message carries both flags');
    assert.ok(typeof rx.snr === 'number');
    report('the station loop closes: text -> air -> interpreted message');
  } catch (err) { report('the station loop closes: text -> air -> interpreted message', err); }

  // ── multi-frame queue drains one frame per period ─────────────────────────
  try {
    const n = engine.setTxText('KN4CRD MSG HELLO FROM POTACAT');
    assert.ok(n >= 2, 'long message must span frames, got ' + n);
    assert.strictEqual(engine.txQueueLength, n);
    // Frames stay queued until TX is enabled — arming is deliberate.
    assert.strictEqual(engine._txEnabled, false);
    engine.setTxText(''); // clear
    assert.strictEqual(engine.txQueueLength, 0);
    report('multi-frame messages queue one frame per period, disarmed by default');
  } catch (err) { report('multi-frame messages queue one frame per period, disarmed by default', err); }

  // ── a message that packs to nothing refuses to arm ────────────────────────
  try {
    const e2 = new Js8Engine(); // no station set
    const n = e2.setTxText('KN4CRD SNR?');
    assert.strictEqual(n, 0, 'no mycall = nothing to send');
    report('TX without a station identity refuses to queue');
  } catch (err) { report('TX without a station identity refuses to queue', err); }

  manager.stopAll();

  console.log(`\nJS8 engine: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => '  ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
