// Audio IPC backpressure policy — the deadlock that blanked the waterfall.
//
// K3SBP 2026-08-05: POTACAT up overnight on WSPR-on-idle, then the JTCAT
// popout was opened. The engine was ALREADY running, so ~190 frames/sec hit
// the new window during the second it took to load — 120 frames with no
// listener registered, hence no acks. The backlog pinned at the cap, main
// dropped every frame from then on ("1875 frames dropped" every 10 s), and
// because a renderer can only ack frames it RECEIVES, the deficit could never
// drain: the waterfall was dead for the life of the window while decode ran
// fine off main's own copy of the feed.
//
// Run: node test/audio-backpressure-test.js
'use strict';

const assert = require('assert');
const bp = require('../lib/audio-backpressure');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

const OPTS = bp.DEFAULTS;
const FPS = 190;
const FRAME_MS = 1000 / FPS;

// Drive N frames from t0, acking per the renderer's batching rule.
// `alive` decides whether the renderer is draining at all.
function run(info, t0, frames, { alive, batch = 20 }) {
  let sent = 0, unacked = 0, t = t0;
  for (let i = 0; i < frames; i++) {
    t = t0 + i * FRAME_MS;
    const v = bp.offerFrame(info, t, OPTS);
    if (v.send) {
      sent++;
      if (alive) {
        unacked++;
        if (unacked >= batch) { bp.noteAck(info, unacked, t, OPTS); unacked = 0; }
      }
    }
  }
  if (alive && unacked) bp.noteAck(info, unacked, t, OPTS);
  return { sent, endMs: t };
}

console.log('healthy consumer:');
{
  const info = bp.createConsumer(0, OPTS);
  const { sent } = run(info, 0, 2000, { alive: true });
  check(sent === 2000, `every frame delivered to a draining renderer (${sent}/2000)`);
  check(info.resyncs === 0, 'no resync needed');
  check(bp.backlog(info) < OPTS.maxBacklog, `backlog stays under the cap (${bp.backlog(info)})`);
}

console.log('\nthe cap still protects a blocked renderer:');
{
  // A renderer that never acks must NOT receive an unbounded stream — that
  // is the 2.2 GB main-RSS leak the cap exists to prevent.
  const info = bp.createConsumer(0, OPTS);
  const { sent } = run(info, 0, 2000, { alive: false }); // ~10.5 s of frames
  check(sent < 400, `a dead consumer gets a small fraction of frames (${sent}/2000)`);
  check(sent >= OPTS.maxBacklog, `…but the first window is delivered (${sent})`);
}

console.log('\nthe deadlock — a consumer that saturated while loading:');
{
  const info = bp.createConsumer(0, OPTS);
  // Phase 1: window exists, no listener yet. 1 s of frames, zero acks.
  const p1 = run(info, 0, Math.round(FPS), { alive: false });
  check(bp.backlog(info) >= OPTS.maxBacklog, `saturated during load (backlog ${bp.backlog(info)})`);
  check(p1.sent === OPTS.maxBacklog, `only the cap got through (${p1.sent})`);

  // Phase 2: the renderer is now alive and would ack anything it receives.
  // Before the fix this delivered ZERO frames, forever. Measure how long the
  // operator actually waits for the waterfall to come back.
  let firstFrameMs = null;
  {
    const t0 = p1.endMs + FRAME_MS;
    let unacked = 0;
    for (let i = 0; i < Math.round(FPS * 5); i++) {
      const t = t0 + i * FRAME_MS;
      const v = bp.offerFrame(info, t, OPTS);
      if (v.send) {
        if (firstFrameMs === null) firstFrameMs = t;
        if (++unacked >= 20) { bp.noteAck(info, unacked, t, OPTS); unacked = 0; }
      }
    }
  }
  check(firstFrameMs !== null, 'frames resume once the renderer is alive');
  // Recovery is one stall interval from the last ack — here the consumer's
  // creation, since it never managed to ack during load.
  check(firstFrameMs !== null && firstFrameMs <= OPTS.stallResyncMs + 50,
    `waterfall comes back within the stall interval (${Math.round(firstFrameMs)}ms)`);
  check(info.resyncs >= 1, `recovery went through a resync (${info.resyncs})`);

  // Phase 3: steady state is clean — no further forgiveness needed.
  const resyncsBefore = info.resyncs;
  const p3 = run(info, p1.endMs + FRAME_MS + FPS * 5 * FRAME_MS, Math.round(FPS * 10), { alive: true });
  check(p3.sent === Math.round(FPS * 10), `steady state delivers everything (${p3.sent})`);
  check(info.resyncs === resyncsBefore, 'no resyncs once healthy');
}

console.log('\nforgiveness backs off for a consumer that never recovers:');
{
  const info = bp.createConsumer(0, OPTS);
  run(info, 0, Math.round(FPS * 60), { alive: false }); // 60 s, never acks
  check(info.resyncs > 0, `some forgiveness happened (${info.resyncs})`);
  check(info.resyncs <= 8, `but it backs off rather than repeating (${info.resyncs} in 60 s)`);
  check(info.resyncMs > OPTS.stallResyncMs, `interval grew (${info.resyncMs}ms)`);
  check(info.resyncMs <= OPTS.stallResyncMaxMs, `and is capped (${info.resyncMs}ms)`);
}

console.log('\nan ack restores trust immediately:');
{
  const info = bp.createConsumer(0, OPTS);
  run(info, 0, Math.round(FPS * 20), { alive: false }); // back off hard
  const backedOff = info.resyncMs;
  check(backedOff > OPTS.stallResyncMs, `backed off first (${backedOff}ms)`);
  bp.noteAck(info, 5, 20000, OPTS);
  check(info.resyncMs === OPTS.stallResyncMs, 'a real ack resets the backoff');
}

console.log('\nbookkeeping:');
{
  const info = bp.createConsumer(0, OPTS);
  bp.offerFrame(info, 0, OPTS);
  bp.noteAck(info, 999, 1, OPTS);
  check(info.acked === info.sent, 'an over-count ack cannot drive acked past sent');
  check(bp.backlog(info) === 0, 'backlog floors at zero');
  const before = info.acked;
  bp.noteAck(info, 0, 2, OPTS);
  bp.noteAck(info, -5, 3, OPTS);
  check(info.acked === before, 'zero/negative acks are ignored');
}

console.log('\ndrop logging is rate-limited:');
{
  const info = bp.createConsumer(0, OPTS);
  run(info, 0, OPTS.maxBacklog, { alive: false }); // saturate
  let logs = 0;
  for (let i = 0; i < 400; i++) {
    // Hold the clock inside one stall interval so these are drops, not resyncs.
    const v = bp.offerFrame(info, 1000 + i, OPTS);
    if (v.logDrop) logs++;
  }
  check(logs <= 1, `at most one drop log per 10 s window (${logs})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'audio backpressure tests failed');
