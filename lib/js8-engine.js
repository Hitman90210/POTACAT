// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
/**
 * Js8Engine — JS8 as a first-class JTCAT engine.
 *
 * The third Ft8Engine-contract sibling (Ft8Engine, PskEngine, this), hosted
 * by jtcat-manager via startSlice({ mode: 'JS8' }). Being a sibling is the
 * entire architecture: slice hosting, audio routing, the tx-start dispatch
 * choke point in main.js (radio-owner arbiter, SWR guard, wrong-band guard,
 * PTT, every audio route), and the waterfall all come for free. There is no
 * JS8Call application, no TCP API, no virtual audio cable — POTACAT *is*
 * the JS8 station. (See docs/js8-native-plan.md for how we got here.)
 *
 * Same two contract traps as PskEngine, both load-bearing:
 *   - Ft8Engine.setMode() COERCES unknown mode strings to FT8, so a
 *     JS8 <-> FT-family switch must REBUILD the slice; the branch lives in
 *     jtcat-manager.startSlice, never in setMode.
 *   - Never write settings.jtcatLastMode with 'JS8'.
 *
 * RX: feedAudio(12 kHz mono) → js8-worker (real JS8Call modem + varicode)
 *     → 'js8-rx' events with fully interpreted frames. Deliberately NOT
 *     routed into the FT8 decode/QSO machinery — JS8 is a conversation
 *     mode; lib/js8call-threads.js consumes these in main.
 *
 * TX: setTxText() builds the frame queue (multi-frame messages are one
 *     frame per period); enabling TX arms it, and each period boundary
 *     emits one 'tx-start' with the standard payload shape
 *     { samples, message, freq, slot, offsetMs } that main.js's dispatch
 *     already knows how to key, route, and failsafe. PTT drops between
 *     frames (each period is an independent transmission, per JS8Call).
 */

'use strict';

const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const path = require('path');

const V = require('./js8-varicode');

const SAMPLE_RATE = 12000;

// Per-submode timing (mirrors JS8Submode.cpp; the addon is authoritative,
// these only drive the engine's wall-clock scheduler).
const SUBMODES = {
  NORMAL: { id: 0, bit: 1 << 0, period: 15, startDelayMs: 500, txSec: 13.14 },
  FAST: { id: 1, bit: 1 << 1, period: 10, startDelayMs: 200, txSec: 8.4 },
  TURBO: { id: 2, bit: 1 << 2, period: 6, startDelayMs: 100, txSec: 4.36 },
  SLOW: { id: 4, bit: 1 << 3, period: 30, startDelayMs: 500, txSec: 26.28 },
  ULTRA: { id: 8, bit: 1 << 4, period: 4, startDelayMs: 100, txSec: 2.72 },
};
const DEFAULT_SUBMODE = 'NORMAL';

class Js8Engine extends EventEmitter {
  constructor() {
    super();
    // Ft8Engine contract fields (read/written externally)
    this._running = false;
    this._txEnabled = false;
    this._txActive = false;
    this._txFreq = 1500;
    this._rxFreq = 1500;
    this._mode = 'JS8';
    this._txMessage = '';

    this._submodeName = DEFAULT_SUBMODE;
    this._worker = null;
    this._workerReady = false;
    this._encodeSeq = 1;
    this._encodeWaiters = new Map(); // id -> {resolve, reject}

    // TX frame queue: [{ frame, bits, samples|null }]
    this._txQueue = [];
    this._txQueueMessage = '';
    this._slotTimer = null;
    this._lastSlot = -1;
    this._txEndTimer = null;

    // Station identity for buildMessageFrames
    this._myCall = '';
    this._myGrid = '';
    this._selectedCall = '';
  }

  get submode() { return SUBMODES[this._submodeName]; }

  setStation({ call, grid } = {}) {
    if (call !== undefined) this._myCall = String(call || '').toUpperCase();
    if (grid !== undefined) this._myGrid = String(grid || '').toUpperCase().slice(0, 4);
  }

  setSelectedCall(call) { this._selectedCall = String(call || '').toUpperCase(); }

  setSubmode(name) {
    const key = String(name || '').toUpperCase();
    if (!SUBMODES[key]) return false;
    this._submodeName = key;
    this._pushDecodeParams();
    return true;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    this._startWorker();
    // The slot clock drives TX; 100 ms is well inside the 500 ms start
    // delay budget and matches the Ft8Engine cadence.
    this._slotTimer = setInterval(() => this._slotTick(), 100);
    this.emit('status', { state: 'running', mode: this._mode });
  }

  stop() {
    this._running = false;
    if (this._slotTimer) { clearInterval(this._slotTimer); this._slotTimer = null; }
    if (this._txEndTimer) { clearTimeout(this._txEndTimer); this._txEndTimer = null; }
    if (this._txActive) {
      this._txActive = false;
      this.emit('tx-end', {});
    }
    this._txQueue = [];
    this._txQueueMessage = '';
    if (this._worker) {
      const w = this._worker;
      this._worker = null;
      this._workerReady = false;
      // Ask first, kill later. terminate() landing while the worker is
      // inside a native decode/encode tears down the isolate under the
      // addon's feet — a deterministic segfault, not a theoretical one. The
      // shutdown message drains the queue (worker messages are processed in
      // order, so any in-flight work finishes first) and the worker closes
      // its own port; terminate() remains only as a 2 s dead-worker fallback.
      try { w.postMessage({ type: 'shutdown' }); } catch { /* already dead */ }
      const killTimer = setTimeout(() => { w.terminate().catch(() => {}); }, 2000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      w.once('exit', () => clearTimeout(killTimer));
    }
    // Cancel, don't error: these rejections resolve on a LATER microtask —
    // by then the manager has already called removeAllListeners(), and an
    // emit('error') with no listener is fatal to the process (observed as a
    // full crash, then a segfault in native-addon worker teardown). A
    // deliberate stop is not an error; the catch below swallows cancels.
    for (const [, waiter] of this._encodeWaiters) {
      const err = new Error('engine stopped');
      err.cancelled = true;
      waiter.reject(err);
    }
    this._encodeWaiters.clear();
    this.emit('status', { state: 'stopped' });
  }

  _startWorker() {
    const w = new Worker(path.join(__dirname, 'js8-worker.js'));
    this._worker = w;
    w.on('message', (msg) => this._onWorkerMessage(msg));
    w.on('error', (err) => {
      this.emit('error', { message: 'js8 worker: ' + (err.message || err) });
    });
    w.on('exit', (code) => {
      if (this._running && this._worker === w) {
        // A dead decoder is a silent radio — restart it, loudly.
        this.emit('error', { message: `js8 worker exited (${code}) — restarting` });
        this._workerReady = false;
        setTimeout(() => { if (this._running) this._startWorker(); }, 1000);
      }
    });
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._workerReady = true;
        this._pushDecodeParams();
        break;
      case 'frames':
        for (const d of msg.decodes) this.emit('js8-rx', d);
        break;
      case 'encode-result': {
        const waiter = this._encodeWaiters.get(msg.id);
        if (waiter) {
          this._encodeWaiters.delete(msg.id);
          waiter.resolve(msg);
        }
        break;
      }
      case 'error': {
        if (msg.id && this._encodeWaiters.has(msg.id)) {
          const waiter = this._encodeWaiters.get(msg.id);
          this._encodeWaiters.delete(msg.id);
          waiter.reject(new Error(msg.message));
        } else {
          this.emit('error', { message: msg.message });
        }
        break;
      }
      default:
        break;
    }
  }

  _pushDecodeParams() {
    if (!this._worker || !this._workerReady) return;
    this._worker.postMessage({
      type: 'decode-params',
      submodes: this.submode.bit,
      nfa: 500,
      nfb: 2700,
      nfqso: Math.round(this._rxFreq),
    });
  }

  // ── RX ─────────────────────────────────────────────────────────────────────

  /**
   * Feed mono 12 kHz audio. Forwarded to the worker; skipped while keyed
   * (the rig's RX is our own sidetone during TX).
   * @param {Float32Array} samples
   */
  feedAudio(samples) {
    if (!this._running || this._txActive) return;
    if (!samples || !samples.length || !this._worker || !this._workerReady) return;
    // Copy: the caller reuses its buffer, and transfer would detach it.
    const copy = new Float32Array(samples);
    this._worker.postMessage({ type: 'audio', samples: copy }, [copy.buffer]);
  }

  setRxFreq(hz) {
    this._rxFreq = Math.max(200, Math.min(4000, Number(hz) || 1500));
    this._pushDecodeParams();
  }

  // ── TX ─────────────────────────────────────────────────────────────────────

  /**
   * Build the frame queue for a message. Returns frame count, or 0 when
   * nothing packs (which the caller must surface — a message that packs to
   * nothing would otherwise arm TX and key silence).
   */
  setTxText(text) {
    this._txMessage = String(text || '');
    this._txQueue = [];
    this._txQueueMessage = '';
    if (!this._txMessage.trim()) return 0;
    if (!this._myCall) return 0;

    const { frames } = V.buildMessageFrames({
      mycall: this._myCall,
      mygrid: this._myGrid,
      selectedCall: this._selectedCall,
      text: this._txMessage,
      submode: this.submode.id,
    });
    this._txQueue = frames.map((f) => ({ ...f, samples: null }));
    this._txQueueMessage = this._txMessage;
    // Pre-render the first frame so the next slot boundary can fire on time.
    this._renderNextFrame();
    return this._txQueue.length;
  }

  get txQueueLength() { return this._txQueue.length; }

  _renderNextFrame() {
    const next = this._txQueue[0];
    if (!next || next.samples || !this._worker || !this._workerReady) return;
    const id = this._encodeSeq++;
    const p = new Promise((resolve, reject) => {
      this._encodeWaiters.set(id, { resolve, reject });
    });
    this._worker.postMessage({
      type: 'encode',
      id,
      frame: next.frame,
      itype: next.bits,
      submode: this.submode.id,
      freq: this._txFreq,
    });
    p.then((msg) => {
      // The queue may have been replaced while we rendered.
      if (this._txQueue[0] === next) next.samples = msg.samples;
    }).catch((err) => {
      if (err && err.cancelled) return;   // deliberate stop, not a failure
      // Guarded emit: 'error' with no listener is fatal to the process, and
      // this callback can outlive the manager's listener teardown.
      if (this.listenerCount('error') > 0) {
        this.emit('error', { message: 'JS8 TX encode failed: ' + err.message });
      }
      this.emit('encode-failed', { frame: next.frame });
    });
  }

  _slotTick() {
    if (!this._running) return;
    const sub = this.submode;
    const periodMs = sub.period * 1000;
    const now = Date.now();
    const slot = Math.floor(now / periodMs);
    if (slot === this._lastSlot) return;
    const intoSlotMs = now - slot * periodMs;
    // Fire only in the first 300 ms of the slot — the audio routes prepend
    // the ~500 ms PTT-settle lead, which lands the first symbol at the
    // submode's start delay. Late ticks wait for the next period.
    if (intoSlotMs > 300) return;
    this._lastSlot = slot;

    if (!this._txEnabled || this._txActive) return;
    const next = this._txQueue[0];
    if (!next) return;
    if (!next.samples) { this._renderNextFrame(); return; } // try next period

    this._txQueue.shift();
    this._txActive = true;

    const durMs = Math.round((next.samples.length / SAMPLE_RATE) * 1000);
    if (this._txEndTimer) clearTimeout(this._txEndTimer);
    this._txEndTimer = setTimeout(() => {
      if (this._txActive) {
        this.emit('log', '[JS8] TX safety timeout — forcing tx-end');
        this.txComplete();
      }
    }, durMs + 3000);

    this.emit('tx-start', {
      samples: next.samples,
      message: this._txMessage,
      frame: next.frame,
      freq: this._txFreq,
      slot: String(slot % 2 === 0 ? 'even' : 'odd'),
      offsetMs: 0,
      framesLeft: this._txQueue.length,
    });

    // Render the following frame while this one is on the air.
    this._renderNextFrame();
  }

  /** Playback complete (called by main.js's dispatch when audio ends). */
  txComplete() {
    if (!this._txActive) return;
    this._txActive = false;
    if (this._txEndTimer) { clearTimeout(this._txEndTimer); this._txEndTimer = null; }
    this.emit('tx-end', {});
    if (this._txQueue.length === 0) {
      this._txEnabled = false;
      this.emit('js8-tx-done', { message: this._txQueueMessage });
      this._txMessage = '';
      this._txQueueMessage = '';
    }
  }

  // ── Ft8Engine-contract stubs ───────────────────────────────────────────────
  // main.js calls these unconditionally on the active engine; they're
  // FT8-slot/WSPR concepts with no JS8 meaning.

  tryImmediateTx() {
    // "Fire now" still respects the period clock — arming is the trigger.
    this._txEnabled = true;
    return this._txQueue.length > 0;
  }
  setMode() { /* JS8 engine is single-family; mode switches rebuild the slice */ }
  setTxSlot() {}
  setHoldTxFreq() {}
  setLateStartTx() {}
  setApContext() {}
  setAudioLatencyMs() {}
  setAudioLatencyAuto() {}
  seedAudioLatencyMs() {}
  setWsprDial() {}
  reBaseline() {}
  encodeMessage() { return Promise.resolve(null); }
}

module.exports = { Js8Engine, SUBMODES, SAMPLE_RATE };
