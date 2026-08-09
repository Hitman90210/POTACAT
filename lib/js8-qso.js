// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8 QSO extraction — the thread IS the QSO record.
//
// JS8 has no rigid QSO state machine to auto-log from; a conversation with
// a station is the exchange, and logging it means reading the exchange
// back out of the thread: who, when, what reports passed each way, where
// they are. This module does that read, purely, so the desktop Log window
// and the mobile log form prefill from ONE implementation and can never
// disagree about what a thread says.
//
// The session rule: a thread can span days of ragchews, and logging "the
// QSO" means the LATEST contiguous exchange — a gap longer than
// SESSION_GAP_MS splits sessions, and everything before the last split is
// a previous contact, not this one.

'use strict';

/** A quiet gap this long ends an exchange; what follows is a new one. */
const SESSION_GAP_MS = 30 * 60 * 1000;

const GRID_RE = /\b[A-R]{2}[0-9]{2}\b/;
// "SNR -12" / "SNR +05" inside a rendered message. The composed forms are
// "CALL: SNR -05" (ours) and "THEM: US SNR -12 " (theirs) — both carry the
// literal token, which is what we parse; JS8's own UI does the same.
const SNR_RE = /\bSNR\s([+-]?\d{1,2})\b/;

function msOf(utc) {
  const n = Number(utc) || 0;
  return n < 1e12 ? n * 1000 : n; // some paths carry epoch seconds
}

function pad2(n) { return String(n).padStart(2, '0'); }

function hhmmss(ms) {
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
}

function yyyymmdd(ms) {
  const d = new Date(ms);
  return String(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
}

/** SNR number formatted the way JS8 logs report it ("-12" / "+05"). */
function fmtSnr(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const v = Math.round(Number(n));
  return (v >= 0 ? '+' : '-') + pad2(Math.abs(v));
}

/**
 * The latest contiguous exchange in a thread's message list.
 * @param {Array} messages  [{dir, text, snr?, offset?, utc}]
 * @returns {Array} the trailing run with no internal gap > SESSION_GAP_MS
 */
function lastSession(messages) {
  const msgs = (messages || []).slice().sort((a, b) => msOf(a.utc) - msOf(b.utc));
  if (!msgs.length) return [];
  let start = 0;
  for (let i = 1; i < msgs.length; i++) {
    if (msOf(msgs[i].utc) - msOf(msgs[i - 1].utc) > SESSION_GAP_MS) start = i;
  }
  return msgs.slice(start);
}

/**
 * Extract a log-form prefill from a JS8 thread.
 *
 * @param {object} thread  { id, call, isGroup, messages } (store shape)
 * @param {object} ctx     { heard?: [{call, grid}], dialHz?: number,
 *                           submode?: string }
 * @returns {object|null}  null for group threads (a net is not a QSO) or an
 *   empty thread; else { callsign, grid, rstSent, rstRcvd, timeOn, timeOff,
 *   qsoDate, freqKhz, mode, submode, messages } — messages is the session
 *   count, for the form's context line.
 */
function extractQsoFromThread(thread, ctx = {}) {
  if (!thread || thread.isGroup) return null;
  const session = lastSession(thread.messages);
  if (!session.length) return null;

  const call = String(thread.call || '').toUpperCase();

  // Their report OF US: the SNR token in an incoming message. Ours TO THEM:
  // the token in an outgoing one. Latest wins in both directions — a
  // re-report supersedes.
  let rstRcvd = '';
  let rstSent = '';
  let bestHeard = null; // strongest we decoded them, the honest fallback
  let grid = '';
  let lastOffset = 0;

  for (const m of session) {
    const text = String(m.text || '');
    const snrTok = SNR_RE.exec(text);
    if (m.dir === 'in') {
      if (snrTok) rstRcvd = fmtSnr(snrTok[1]);
      if (typeof m.snr === 'number' && (bestHeard === null || m.snr > bestHeard)) {
        bestHeard = m.snr;
      }
      if (m.offset) lastOffset = m.offset;
      if (!grid) {
        const g = GRID_RE.exec(text);
        if (g) grid = g[0];
      }
    } else if (snrTok) {
      rstSent = fmtSnr(snrTok[1]);
    }
  }

  // The heard rail's HB-captured grid outranks a grid scraped from text —
  // it came from a structured heartbeat, not a word that happened to match.
  const heardRow = (ctx.heard || []).find((h) => h && h.call === call);
  if (heardRow && heardRow.grid) grid = String(heardRow.grid).toUpperCase();

  if (!rstSent && bestHeard !== null) rstSent = fmtSnr(bestHeard);

  const startMs = msOf(session[0].utc);
  const endMs = msOf(session[session.length - 1].utc);

  const dialHz = Number(ctx.dialHz) || 0;
  const freqKhz = dialHz ? (dialHz + lastOffset) / 1000 : null;

  return {
    callsign: call,
    grid,
    rstSent,
    rstRcvd,
    timeOn: hhmmss(startMs),
    timeOff: hhmmss(endMs),
    qsoDate: yyyymmdd(startMs),
    freqKhz,
    mode: 'JS8',
    submode: String(ctx.submode || 'NORMAL').toUpperCase(),
    messages: session.length,
  };
}

module.exports = {
  extractQsoFromThread,
  lastSession,
  fmtSnr,
  SESSION_GAP_MS,
};
