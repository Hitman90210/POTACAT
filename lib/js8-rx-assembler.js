// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8 RX message assembler — the MessageBuffer role from JS8Call's main
// window, as a pure module.
//
// A JS8 message longer than one frame arrives as a directed frame followed
// by data frames, tied together only by their audio offset and the
// First/Last itype flags. An inbox fed raw frames would thread fragments;
// this assembles them into complete messages and validates/strips the
// trailing checksum that buffered directed commands carry.
//
// Buckets are keyed by coarse audio offset (stations sit still within a
// QSO; ±10 Hz of drift is normal) and expire after a missed period or two,
// because the other half of a message that never arrives must not poison
// the next station to use that offset.

'use strict';

const V = require('./js8-varicode');

/** Offset bucket width, Hz. */
const BUCKET_HZ = 10;
/** Buckets idle longer than this many ms are dropped. */
const STALE_MS = 90 * 1000;

class Js8RxAssembler {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._buffers = new Map(); // bucket -> { frames: [], directed, startedAt, lastAt }
  }

  _bucket(freq) { return Math.round(freq / BUCKET_HZ); }

  _expire() {
    const now = this._now();
    for (const [k, b] of this._buffers) {
      if (now - b.lastAt > STALE_MS) this._buffers.delete(k);
    }
  }

  /**
   * Ingest one interpreted frame (the js8-rx event payload). Returns null
   * while a message is building, or a completed message:
   *   { from, to, cmd, text, snr, freq, utc, checksumValid|null, frames }
   *
   * Frames that are complete in themselves (heartbeats, plain directed
   * with both flags, compound announcements) complete immediately.
   */
  ingest(d) {
    this._expire();
    const bucket = this._bucket(d.freq);
    const now = this._now();

    // A First frame always starts fresh — whatever was in the bucket is a
    // remnant of a message whose Last we missed.
    if (d.isFirst) this._buffers.delete(bucket);

    let buf = this._buffers.get(bucket);
    if (!buf) {
      // Data frames without a preceding First are continuations of
      // something we never heard the start of; surface them as-is rather
      // than silently dropping (JS8Call shows them too).
      if (!d.isFirst && d.frameType === V.FrameType.FrameData) {
        return this._finish({ frames: [d], startedAt: now, lastAt: now });
      }
      buf = { frames: [], startedAt: now, lastAt: now };
      this._buffers.set(bucket, buf);
    }

    buf.frames.push(d);
    buf.lastAt = now;

    if (d.isLast) {
      this._buffers.delete(bucket);
      return this._finish(buf);
    }
    return null;
  }

  /** Assemble a completed buffer into one message object. */
  _finish(buf) {
    const frames = buf.frames;
    const first = frames[0];

    let from = '';
    let to = '';
    let cmd = '';
    let num = '';
    // The head frame carries the addressing. Directed: [from, to, cmd,
    // num?]. Heartbeat/compound: the compound call.
    if (first.directed && first.directed.length >= 3) {
      from = first.directed[0];
      to = first.directed[1];
      cmd = first.directed[2];
      num = first.directed[3] || '';
    } else if (first.compound) {
      from = first.compound;
    }

    let text = frames.map((f) => f.message).join('');

    // Buffered directed commands carry a trailing checksum over the data
    // that follows the command. Validate and STRIP it — the operator wants
    // the message, and a bad checksum wants a flag, not a mystery suffix.
    let checksumValid = null;
    if (cmd && V.isCommandBuffered(cmd) && frames.length > 1) {
      const size = V.isCommandChecksumed(cmd);
      const data = frames.slice(1).map((f) => f.message).join('');
      if (size === 16 && data.length > 4) {
        const payload = data.slice(0, -4);
        const check = data.slice(-3);
        if (V.checksum16Valid(check, payload)) {
          checksumValid = true;
          text = frames[0].message + payload;
        } else {
          checksumValid = false;
        }
      } else if (size === 32 && data.length > 7) {
        const payload = data.slice(0, -7);
        const check = data.slice(-6);
        if (V.checksum32Valid(check, payload)) {
          checksumValid = true;
          text = frames[0].message + payload;
        } else {
          checksumValid = false;
        }
      }
    }

    // Best SNR across the frames — the station didn't get weaker because
    // its message was long.
    let snr = -99;
    for (const f of frames) if (typeof f.snr === 'number' && f.snr > snr) snr = f.snr;

    return {
      from,
      to,
      cmd,
      num,
      text,
      snr,
      freq: first.freq,
      utc: first.utc,
      submode: first.mode,
      isHeartbeat: !!first.isHeartbeat,
      isAlt: !!first.isAlt,
      frameType: first.frameType,
      checksumValid,
      frames: frames.length,
    };
  }

  /** Buckets currently mid-message (for tests/diagnostics). */
  get pending() { return this._buffers.size; }
}

module.exports = { Js8RxAssembler, BUCKET_HZ, STALE_MS };
