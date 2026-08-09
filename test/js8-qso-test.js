#!/usr/bin/env node
'use strict';
/**
 * JS8 QSO extraction — the thread IS the QSO record.
 *
 * The rule worth protecting: what lands in the log must be what the
 * exchange actually said — their report of us from THEIR message, ours
 * from OURS (falling back to what we honestly heard), and the times from
 * the LATEST exchange, because a thread that spans three days of ragchews
 * must not log a QSO that started Tuesday.
 *
 * Run: node test/js8-qso-test.js
 */

const assert = require('assert');
const { extractQsoFromThread, lastSession, fmtSnr, SESSION_GAP_MS } = require('../lib/js8-qso');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const T0 = Date.UTC(2026, 7, 9, 14, 30, 0);
const m = (dir, text, utcOffsetSec, extra = {}) => ({
  dir, text, utc: T0 + utcOffsetSec * 1000, ...extra,
});

test('a group thread is not a QSO', () => {
  assert.strictEqual(extractQsoFromThread({ id: '@ALLCALL', call: '@ALLCALL', isGroup: true, messages: [m('in', 'HB', 0)] }), null);
});

test('reports go the right directions', () => {
  const thread = {
    id: 'KN4CRD', call: 'KN4CRD', isGroup: false,
    messages: [
      m('in', 'KN4CRD: K3SBP SNR -12 ', 0, { snr: -7, offset: 1500 }),
      m('out', 'KN4CRD: SNR -05', 30),
      m('in', 'KN4CRD: K3SBP 73 ', 60, { snr: -6, offset: 1502 }),
    ],
  };
  const q = extractQsoFromThread(thread, { dialHz: 14078000, submode: 'NORMAL' });
  assert.strictEqual(q.callsign, 'KN4CRD');
  assert.strictEqual(q.rstRcvd, '-12', 'their report OF US');
  assert.strictEqual(q.rstSent, '-05', 'the report WE sent');
  assert.strictEqual(q.timeOn, '143000');
  assert.strictEqual(q.timeOff, '143100');
  assert.strictEqual(q.qsoDate, '20260809');
  assert.strictEqual(Math.round(q.freqKhz * 1000), 14079502000 / 1000, 'dial + last offset');
  assert.strictEqual(q.mode, 'JS8');
});

test('no sent report falls back to the best SNR we heard them at', () => {
  const thread = {
    id: 'W1AW', call: 'W1AW', isGroup: false,
    messages: [
      m('in', 'W1AW: K3SBP HELLO ', 0, { snr: -15 }),
      m('in', 'W1AW: K3SBP HW CPY? ', 30, { snr: -9 }),
    ],
  };
  const q = extractQsoFromThread(thread, {});
  assert.strictEqual(q.rstSent, '-09', 'strongest decode = what we would report');
  assert.strictEqual(q.rstRcvd, '', 'they never reported us — leave it empty, never invent');
});

test('a three-day thread logs only the latest exchange', () => {
  const old = m('in', 'W1AW: K3SBP SNR -20 ', 0, { snr: -20 });
  const gap = SESSION_GAP_MS / 1000 + 3600;
  const thread = {
    id: 'W1AW', call: 'W1AW', isGroup: false,
    messages: [
      old,
      m('in', 'W1AW: K3SBP SNR -04 ', gap, { snr: -4 }),
      m('out', 'W1AW: SNR -07', gap + 30),
    ],
  };
  const q = extractQsoFromThread(thread, {});
  assert.strictEqual(q.rstRcvd, '-04', 'the old session\'s report must not leak in');
  assert.strictEqual(q.messages, 2, 'session = the trailing contiguous run');
  assert.strictEqual(q.timeOn, new Date(T0 + gap * 1000).toISOString().slice(11, 19).replace(/:/g, ''));
  assert.strictEqual(lastSession(thread.messages).length, 2);
});

test('the heard rail grid outranks a text-scraped one', () => {
  const thread = {
    id: 'W1AW', call: 'W1AW', isGroup: false,
    messages: [m('in', 'W1AW: K3SBP EM73 IS NOT MY GRID ', 0, { snr: -5 })],
  };
  const q = extractQsoFromThread(thread, { heard: [{ call: 'W1AW', grid: 'FN31' }] });
  assert.strictEqual(q.grid, 'FN31', 'structured HB capture beats a word that matched');
  const q2 = extractQsoFromThread(thread, {});
  assert.strictEqual(q2.grid, 'EM73', 'but scraping is the honest fallback');
});

test('a positive SNR formats with its sign', () => {
  assert.strictEqual(fmtSnr(5), '+05');
  assert.strictEqual(fmtSnr(-12), '-12');
  assert.strictEqual(fmtSnr(0), '+00');
});

console.log(`\nJS8 QSO extraction: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
