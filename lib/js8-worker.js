// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
/**
 * JS8 decode/encode worker thread.
 *
 * Hosts the js8_native addon (the real JS8Call modem — see
 * third_party/js8call/NOTES.md) plus the varicode message layer, in a
 * worker so a decode pass (hundreds of ms of LDPC) never stalls the main
 * process. Same containment pattern as ft8-worker.js.
 *
 * Messages IN:
 *   { type: 'audio', samples: Float32Array }   — 12 kHz mono, appended to the ring
 *   { type: 'decode-params', submodes, nfa, nfb, nfqso }
 *   { type: 'encode', id, frame, itype, submode, freq }
 *   { type: 'reset' }
 *
 * Messages OUT:
 *   { type: 'ready' }
 *   { type: 'frames', decodes: [{ utc, snr, dt, freq, type, quality, mode,
 *       text, message, frameType, compound, directed, isFirst, isLast,
 *       isHeartbeat, isAlt }] }
 *   { type: 'encode-result', id, samples: Float32Array, tones }
 *   { type: 'error', id?, message }
 *
 * The decode SCHEDULE lives in the addon (the isDecodeReady port): every
 * audio append is followed by a decode() call, which is nearly free until a
 * submode's period window fills — so the worker needs no timers and the
 * decode cadence follows the audio clock, not the wall clock.
 */

'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');

const V = require('./js8-varicode');

let addon = null;
try {
  addon = require(path.join(__dirname, 'js8_native', 'build', 'Release', 'js8_native.node'));
} catch (err) {
  parentPort.postMessage({
    type: 'error',
    message: 'js8_native addon not built (npm run build-js8): ' + (err.message || err),
  });
}

let decodeParams = { submodes: 1, nfa: 200, nfb: 3200, nfqso: 1500 };

function utcNow() {
  const d = new Date();
  return d.getUTCHours() * 10000 + d.getUTCMinutes() * 100 + d.getUTCSeconds();
}

parentPort.on('message', (msg) => {
  if (!msg || !addon) return;
  try {
    switch (msg.type) {
      case 'audio': {
        const samples = msg.samples instanceof Float32Array
          ? msg.samples : new Float32Array(msg.samples);
        addon.appendAudio(samples);
        const r = addon.decode({ ...decodeParams, utc: utcNow() });
        // Diagnostic: a decode that RAN (a period window fired) is the proof
        // the RX pipeline is alive. Report each run — cheap (once per period)
        // and turns "no decodes" from a guess into a fact: window fired but
        // zero copies (alignment/SNR) vs never fired (feed/anchor) vs never
        // fed (audio path). Silenced once real decodes flow.
        if (r.ran) {
          parentPort.postMessage({ type: 'decode-ran', ran: r.ran, k: r.k, decodes: r.decodes.length });
        }
        if (r.decodes.length) {
          const decodes = r.decodes.map((d) => {
            const info = V.interpretFrame(d.text, d.type, d.mode);
            return {
              ...d,
              message: info.message,
              frameType: info.frameType,
              frameTypeString: V.frameTypeString(info.frameType),
              compound: info.compound,
              directed: info.directed,
              extra: info.extra,
              isFirst: info.isFirst,
              isLast: info.isLast,
              isHeartbeat: info.isHeartbeat,
              isAlt: info.isAlt,
              lowConfidence: d.quality < V.QUALITY_THRESHOLD,
            };
          });
          parentPort.postMessage({ type: 'frames', decodes });
        }
        break;
      }
      case 'decode-params': {
        decodeParams = {
          submodes: msg.submodes ?? decodeParams.submodes,
          nfa: msg.nfa ?? decodeParams.nfa,
          nfb: msg.nfb ?? decodeParams.nfb,
          nfqso: msg.nfqso ?? decodeParams.nfqso,
        };
        break;
      }
      case 'encode': {
        const enc = addon.encode({
          frame: msg.frame,
          type: msg.itype ?? 0,
          submode: msg.submode ?? 0,
          freq: msg.freq ?? 1500,
          sampleRate: 12000,
        });
        parentPort.postMessage(
          { type: 'encode-result', id: msg.id, samples: enc.audio, tones: Array.from(enc.tones) },
          [enc.audio.buffer],
        );
        break;
      }
      case 'reset': {
        addon.reset();
        break;
      }
      case 'shutdown': {
        // Graceful exit: finish the current message (we are inside the
        // handler, so any native call has already returned) and close the
        // port, which ends the event loop and lets the thread exit CLEANLY.
        // The alternative — worker.terminate() landing mid-decode — tears
        // down the isolate inside the native addon and segfaults node
        // (observed deterministically on Windows). The engine only escalates
        // to terminate() if this path never runs.
        parentPort.close();
        break;
      }
      default:
        break;
    }
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      id: msg.id,
      message: String((err && err.message) || err),
    });
  }
});

parentPort.postMessage({ type: 'ready' });
