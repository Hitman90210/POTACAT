'use strict';

// Pure date-window matcher for event-progress rebuilds (scanLogForEvents).
//
// Event progress ("did I work this station during the event?") is a multi-day
// checklist, so a logged QSO's membership in a schedule window is decided at UTC
// *day* granularity, inclusive of the window's start and end days.
//
// This deliberately replaces the earlier instant-precise comparison, which
// synthesized every logged QSO at 12:00Z and required `instant >= start`. For a
// window that begins or ends at a non-midnight UTC time — 13 Colonies runs
// 1300z Jul 1 → 0400z Jul 8 — that discarded every start-day QSO (noon precedes
// the 1300z start) and every end-day QSO (noon follows the 0400z end), wiping
// the checklist on the next launch when the log is re-scanned. The live marker
// (checkEventQso) uses the real clock, so stations ticked correctly during the
// session and then vanished on restart.
//
// Regions/WAS windows are already full-day (00:00:00–23:59:59), so day-level
// matching yields identical results there. Counter events don't use this path.

/**
 * @param {string} qsoDateStr - ADIF QSO_DATE, "YYYYMMDD"
 * @param {{start:string,end:string}} entry - schedule entry with ISO start/end
 * @returns {boolean} true if the QSO's UTC day is within [start-day, end-day] inclusive
 */
function qsoDayInScheduleEntry(qsoDateStr, entry) {
  if (!qsoDateStr || qsoDateStr.length < 8 || !entry) return false;
  const day = `${qsoDateStr.slice(0, 4)}-${qsoDateStr.slice(4, 6)}-${qsoDateStr.slice(6, 8)}`;
  const startDay = String(entry.start || '').slice(0, 10);
  const endDay = String(entry.end || '').slice(0, 10);
  if (!startDay || !endDay) return false;
  return day >= startDay && day <= endDay;
}

// ---------------------------------------------------------------------------
// Identity-proven event matching (2026-07-09). Shared by checkEventQso's
// progress marking AND saveQsoRecord's event stamping so the two can't drift.
// ---------------------------------------------------------------------------

/** Checklist boards: exact station call (or CALL/suffix) against tracking items. */
function matchChecklistItem(items, call) {
  const c = String(call || '').toUpperCase();
  if (!c) return null;
  return (items || []).find((it) =>
    it && it.id && (c === it.id.toUpperCase() || c.startsWith(it.id.toUpperCase() + '/'))) || null;
}

/** Regions/WAS boards: callsign pattern list ("W2S/*" wildcard or exact). */
function matchRegionPatterns(patterns, call) {
  const c = String(call || '').toUpperCase();
  if (!c) return false;
  return (patterns || []).some((p) =>
    String(p).endsWith('/*') ? c.startsWith(String(p).slice(0, -1)) : c === String(p).toUpperCase());
}

/** The schedule entry covering `now`, or null. */
function activeScheduleEntry(ev, now) {
  return ((ev && ev.schedule) || []).find((s) =>
    now >= new Date(s.start) && now < new Date(s.end)) || null;
}

/** ALL schedule entries covering `now` (regions events run concurrent weeks). */
function coveringScheduleEntries(ev, now) {
  return ((ev && ev.schedule) || []).filter((s) =>
    now >= new Date(s.start) && now < new Date(s.end));
}

/**
 * US call-district table for W1AW-style WAS events. THE canonical copy —
 * renderer/app.js carries a display twin (W1AW_STATE_DISTRICT) that MUST
 * stay in sync. Its 8/0 rows were transposed until 2026-08-14 (WG9I: the
 * banner paired Ohio with W1AW/0 and Iowa with W1AW/8), so any edit here
 * gets triple-checked against the FCC district map.
 */
const US_CALL_DISTRICT = {
  CT: '1', ME: '1', MA: '1', NH: '1', RI: '1', VT: '1',
  NJ: '2', NY: '2',
  DE: '3', DC: '3', MD: '3', PA: '3',
  AL: '4', FL: '4', GA: '4', KY: '4', NC: '4', SC: '4', TN: '4', VA: '4',
  AR: '5', LA: '5', MS: '5', NM: '5', OK: '5', TX: '5',
  CA: '6',
  AZ: '7', ID: '7', MT: '7', NV: '7', OR: '7', UT: '7', WA: '7', WY: '7',
  MI: '8', OH: '8', WV: '8',
  IL: '9', IN: '9', WI: '9',
  CO: '0', IA: '0', KS: '0', MN: '0', MO: '0', NE: '0', ND: '0', SD: '0',
  AK: 'KL7', HI: 'KH6', GU: 'KH2', PR: 'KP4', VI: 'KP2',
};

/**
 * Derive an entry's callsign patterns from its region's call district when
 * the payload didn't carry explicit `patterns`. Only possible when the
 * event's own pattern is a single-base wildcard ("W1AW/*" → "W1AW/8" for
 * OH). Returns null when underivable (non-US region, no wildcard base).
 */
function deriveRegionPatterns(ev, entry) {
  const district = US_CALL_DISTRICT[String((entry && entry.region) || '').toUpperCase()];
  if (!district) return null;
  const bases = ((ev && ev.callsignPatterns) || [])
    .filter((p) => String(p).endsWith('/*'))
    .map((p) => String(p).slice(0, -2));
  if (!bases.length) return null;
  return bases.map((b) => `${b}/${district}`);
}

/**
 * The covering entry a call belongs to, honoring per-entry `patterns`
 * (additive schema, website-agent audit 2026-07-09): America250 runs 2–4
 * states in the same week, all matching the event-level "W1AW/*" — a
 * per-entry pattern list (e.g. { region: "IN", patterns: ["W1AW/9"] })
 * disambiguates which state a QSO actually was. Entries without `patterns`
 * get district-DERIVED patterns when possible — the old fall-through to the
 * event-level wildcard made the FIRST covering entry win for EVERY suffix,
 * which mis-stamped every multi-state week (WG9I 2026-08-14: /7 Oregon
 * stamped New Jersey, /KL7 Alaska stamped Tennessee). The event-level list
 * remains the last resort for underivable regions, where a single covering
 * entry is the only case it can answer correctly.
 */
function matchingRegionEntry(ev, call, entries) {
  for (const entry of entries || []) {
    const pats = (entry && Array.isArray(entry.patterns) && entry.patterns.length)
      ? entry.patterns
      : (deriveRegionPatterns(ev, entry) || (ev && ev.callsignPatterns));
    if (matchRegionPatterns(pats, call)) return entry;
  }
  return null;
}

/**
 * Recompute the region for every record already stamped with this event and
 * report the ones whose stamp DISAGREES — the healing half of retro-stamp
 * (retroStampMatches only fills missing stamps). Only corrections with a
 * positive new answer are reported; a stamped record the fixed matcher can't
 * place at all (out-of-schedule op, edited date) is left alone and counted,
 * because removing log data on a guess is worse than a stale tag.
 */
function retroCorrectStamps(ev, rawQsos) {
  const out = { corrections: [], unresolvable: 0 };
  if (!ev) return out;
  const board = ev.board || (ev.tracking && ev.tracking.type) || 'regions';
  if (board !== 'regions') return out;
  const sched = ev.schedule || [];
  for (let i = 0; i < (rawQsos || []).length; i++) {
    const r = rawQsos[i];
    if (!r || String(r.APP_POTACAT_EVENT || '').trim() !== ev.id) continue;
    const call = String(r.CALL || '').toUpperCase();
    if (!call) continue;
    const covering = sched.filter((s) => qsoDayInScheduleEntry(r.QSO_DATE || '', s));
    const entry = covering.length ? matchingRegionEntry(ev, call, covering) : null;
    const stamped = String(r.APP_POTACAT_EVENT_ITEM || '').trim();
    if (!entry) { if (stamped) out.unresolvable++; continue; }
    if ((entry.region || '') === stamped) continue;
    out.corrections.push({ index: i, item: entry.region || '', itemName: entry.regionName || '', prevItem: stamped });
  }
  return out;
}

/**
 * Should this QSO carry an event stamp in the log?
 *
 * Only IDENTITY-PROVEN matches stamp: checklist boards (the worked call IS an
 * event station — 13 Colonies K2A…GB13COL) and regions boards (the call
 * matches the event's pattern list — America250/WAS-style). Counter boards
 * ("any QSO during the window counts") are deliberately excluded — being on
 * the air during a contest weekend is not proof of participation, and a false
 * CONTEST/event tag in the log is worse than a missing one. Gated on the
 * operator tracking the event (optedIn), mirroring progress marking.
 *
 * @returns {null | {eventId, eventName, item, itemName}}
 */
function matchEventQsoForStamp(activeEvents, eventsState, call, now) {
  for (const ev of activeEvents || []) {
    const state = eventsState && eventsState[ev.id];
    if (!state || !state.optedIn) continue;
    const covering = coveringScheduleEntries(ev, now);
    if (!covering.length) continue;
    const board = ev.board || (ev.tracking && ev.tracking.type) || 'regions';
    if (board === 'checklist') {
      const item = matchChecklistItem(ev.tracking && ev.tracking.items, call);
      if (item) return { eventId: ev.id, eventName: ev.name || ev.id, item: item.id, itemName: item.name || '' };
    } else if (board === 'regions') {
      const entry = matchingRegionEntry(ev, call, covering);
      if (entry) {
        return { eventId: ev.id, eventName: ev.name || ev.id, item: entry.region || '', itemName: entry.regionName || '' };
      }
    }
    // board === 'counter': never stamp (see above)
  }
  return null;
}

/**
 * Retro-stamp candidates (events-roadmap #3): log records that belong to an
 * event but carry no stamp yet. Identity-proven only — the same predicates
 * live stamping uses — with day-granular schedule windows like the log
 * re-scan. Counter boards never stamp. Records already stamped with ANY
 * event are skipped (one event per record; first stamp wins).
 *
 * @param {object} ev       event definition
 * @param {Array}  rawQsos  raw ADIF records (uppercase field names)
 * @returns {Array<{index:number, item:string, itemName:string}>}
 */
function retroStampMatches(ev, rawQsos) {
  const out = [];
  if (!ev) return out;
  const board = ev.board || (ev.tracking && ev.tracking.type) || 'regions';
  if (board !== 'checklist' && board !== 'regions') return out;
  const sched = ev.schedule || [];
  if (!sched.length) return out;
  for (let i = 0; i < (rawQsos || []).length; i++) {
    const r = rawQsos[i];
    if (!r || r.APP_POTACAT_EVENT) continue;
    const call = String(r.CALL || '').toUpperCase();
    if (!call) continue;
    const covering = sched.filter((s) => qsoDayInScheduleEntry(r.QSO_DATE || '', s));
    if (!covering.length) continue;
    if (board === 'checklist') {
      const item = matchChecklistItem(ev.tracking && ev.tracking.items, call);
      if (item) out.push({ index: i, item: item.id, itemName: item.name || '' });
    } else {
      const entry = matchingRegionEntry(ev, call, covering);
      if (entry) out.push({ index: i, item: entry.region || '', itemName: entry.regionName || '' });
    }
  }
  return out;
}

module.exports = {
  qsoDayInScheduleEntry,
  matchChecklistItem,
  matchRegionPatterns,
  activeScheduleEntry,
  coveringScheduleEntries,
  matchingRegionEntry,
  matchEventQsoForStamp,
  retroStampMatches,
  retroCorrectStamps,
  deriveRegionPatterns,
  US_CALL_DISTRICT,
};
