'use strict';
/**
 * Per-consumer audio IPC backpressure policy — pure, so the tricky part is
 * testable (test/audio-backpressure-test.js).
 *
 * Main forwards ~190 audio frames/sec to each renderer that wants them. A
 * renderer that can't drain its IPC pipe accumulates undelivered payloads in
 * MAIN's native buffers (2.2 GB RSS in 30 min — K3SBP 2026-05-25), so every
 * consumer is a bounded queue: renderers batch-ack, main tracks sent−acked,
 * and frames are dropped for a consumer whose backlog hits the cap.
 *
 * The cap ALONE deadlocks. Main stops sending when saturated, but a renderer
 * can only ack frames it RECEIVES — so a consumer that saturated while it had
 * no listener yet (a popout window during the ~1 s it takes to load, with the
 * engine already running) can never drain, and is starved for the entire life
 * of the window. K3SBP 2026-08-05: JTCAT popout opened after an overnight
 * WSPR run, waterfall permanently blank, "1875 frames dropped" every 10 s —
 * every single frame — while decode ran fine off main's own copy of the feed.
 *
 * Fix: forgive an un-ackable deficit after a stall. A renderer that was
 * merely still loading recovers on the first forgiveness and acks from then
 * on. A genuinely blocked renderer (minimized/throttled — the case the cap
 * exists for) re-saturates at once, so the interval backs off exponentially
 * and its cost decays to one short burst per minute. Any real ack resets it.
 */

const DEFAULTS = {
  maxBacklog: 120,        // frames; ~640 ms at 190 fps
  stallResyncMs: 2000,    // first forgiveness after this long with no ack
  stallResyncMaxMs: 60000, // backoff ceiling for a consumer that never acks
};

/** Fresh per-consumer state. `nowMs` seeds the stall clock. */
function createConsumer(nowMs, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  return {
    sent: 0,
    acked: 0,
    dropped: 0,
    lastDropLogMs: 0,
    lastAckMs: nowMs,
    lastResyncMs: 0,
    resyncMs: o.stallResyncMs,
    resyncs: 0,
  };
}

/** Frames sent but not yet acked. */
function backlog(info) {
  return info.sent - info.acked;
}

/**
 * Decide what to do with one outgoing frame, MUTATING `info` to record it.
 *
 * @returns {{send:boolean, resynced:boolean, logDrop:boolean}}
 *   send      — hand the frame to the renderer
 *   resynced  — the deficit was just forgiven (worth one log line)
 *   logDrop   — this drop should be logged (rate-limited to one per 10 s)
 */
function offerFrame(info, nowMs, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (backlog(info) < o.maxBacklog) {
    info.sent++;
    return { send: true, resynced: false, logDrop: false };
  }
  // Saturated. Forgive only after a full stall interval with no ack AND no
  // recent forgiveness — otherwise a dead consumer would be forgiven on
  // every frame and the cap would mean nothing.
  const quietSince = Math.max(info.lastAckMs, info.lastResyncMs);
  if (nowMs - quietSince >= info.resyncMs) {
    info.lastResyncMs = nowMs;
    info.resyncs++;
    info.acked = info.sent; // the un-ackable deficit is written off
    info.resyncMs = Math.min(info.resyncMs * 2, o.stallResyncMaxMs);
    info.sent++;
    return { send: true, resynced: true, logDrop: false };
  }
  info.dropped++;
  const logDrop = nowMs - info.lastDropLogMs >= 10000;
  if (logDrop) info.lastDropLogMs = nowMs;
  return { send: false, resynced: false, logDrop };
}

/**
 * Record an ack. Proof the renderer is alive and draining, so the backoff
 * resets and the deficit is clamped (a resync can leave acked > sent
 * bookkeeping otherwise).
 */
function noteAck(info, count, nowMs, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const n = Math.max(0, count | 0);
  if (!n) return;
  info.acked += n;
  if (info.acked > info.sent) info.acked = info.sent;
  info.lastAckMs = nowMs;
  info.resyncMs = o.stallResyncMs;
}

module.exports = { DEFAULTS, createConsumer, backlog, offerFrame, noteAck };
