// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// WSPR daily rollup — pure state transforms for the per-UTC-day counters.
//
// The question this answers is Casey's: "how did the idle receiver do
// today, and did its reports actually go anywhere?" Decodes counted as
// they land, uploads counted per destination as they happen, history kept
// per day. main.js owns persistence (<userData>/wspr-daily.json) and the
// summary log lines; everything here is data in, data out, tested.
//
// Honesty note carried in the field names: wsprnet uploads are
// request/response so `uploadedWsprnet` means ACCEPTED; PSKReporter is
// fire-and-forget UDP with no ack, so `sentPskr` means SENT, and no code
// or copy should ever promote it to "received".

'use strict';

/** UTC day key for a timestamp. */
function dayKey(ms) {
  const d = new Date(ms);
  return String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
}

function emptyDay(date) {
  return {
    date,
    decoded: 0,
    calls: [],          // unique calls heard (array for JSON; set semantics)
    bestDxMi: 0,
    bestDxCall: '',
    uploadedWsprnet: 0, // accepted by wsprnet.org
    sentPskr: 0,        // sent to PSKReporter (UDP — no ack exists)
    batches: 0,         // 2-minute cycles that produced at least one decode
  };
}

/**
 * Fold a decode batch and/or upload counts into the rollup.
 *
 * @param {object} state  { days: { [date]: day } } (or null/empty)
 * @param {object} ev     { nowMs, spots?, uploadedWsprnet?, sentPskr? }
 * @returns {{state: object, day: object, rolledOver: object|null}}
 *   rolledOver = the finished previous day the FIRST time an event lands on
 *   a new date — the caller's cue to log the summary line exactly once.
 */
function fold(state, ev) {
  const s = state && state.days ? state : { days: {}, current: '' };
  const date = dayKey(ev.nowMs || Date.now());
  let rolledOver = null;
  if (s.current && s.current !== date && s.days[s.current]) {
    rolledOver = s.days[s.current];
  }
  s.current = date;
  const day = s.days[date] || (s.days[date] = emptyDay(date));

  const spots = ev.spots || [];
  if (spots.length) {
    day.decoded += spots.length;
    day.batches += 1;
    for (const sp of spots) {
      if (sp && sp.call && !day.calls.includes(sp.call)) day.calls.push(sp.call);
      if (sp && Number(sp.distanceMi) > day.bestDxMi) {
        day.bestDxMi = Math.round(Number(sp.distanceMi));
        day.bestDxCall = sp.call || '';
      }
    }
  }
  if (ev.uploadedWsprnet) day.uploadedWsprnet += ev.uploadedWsprnet;
  if (ev.sentPskr) day.sentPskr += ev.sentPskr;

  // Keep a bounded history — a year of daily rows is tiny, but unbounded
  // files rot. 400 days covers year-over-year comparison.
  const keys = Object.keys(s.days).sort();
  while (keys.length > 400) delete s.days[keys.shift()];

  return { state: s, day, rolledOver };
}

/** One-line human summary of a day — the CAT-log / rollover line. */
function summarize(day) {
  if (!day || !day.decoded) return 'WSPR ' + (day ? day.date : '') + ': no decodes';
  const parts = [
    `${day.decoded} decode${day.decoded === 1 ? '' : 's'}`,
    `${day.calls.length} call${day.calls.length === 1 ? '' : 's'}`,
  ];
  if (day.bestDxMi) parts.push(`best DX ${day.bestDxMi.toLocaleString('en-US')} mi (${day.bestDxCall})`);
  parts.push(`${day.uploadedWsprnet} accepted by wsprnet`);
  parts.push(`${day.sentPskr} sent to PSKReporter`);
  return `WSPR ${day.date}: ` + parts.join(', ');
}

/** The compact per-day counters the wire carries (wspr-session.today). */
function todayPayload(day) {
  if (!day) return null;
  return {
    date: day.date,
    decoded: day.decoded,
    uniqueCalls: day.calls.length,
    bestDxMi: day.bestDxMi,
    bestDxCall: day.bestDxCall,
    uploadedWsprnet: day.uploadedWsprnet,
    sentPskr: day.sentPskr,
  };
}

module.exports = { fold, summarize, todayPayload, dayKey, emptyDay };
