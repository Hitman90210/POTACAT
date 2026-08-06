// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Radio-owner arbiter (pure) — a tiny mutual-exclusion decision for the ONE
// exclusive radio TX/audio path. POTACAT has several things that can key the
// rig and own its audio: the JTCAT/FT8 engine and the Mercury HF data modem in
// particular can NOT both be active at once (they'd race PTT and mix audio).
// Today ownership is only an implicit boolean; this makes it explicit and
// testable, the same way decideRetryOutcome() factors the JTCAT retry policy
// out of main.js.
//
// This module is pure policy — no sockets, no timers, no main.js state. main.js
// holds the single `radioOwner` variable and calls these to decide transitions.

'use strict';

// Long-lived exclusive owners. Transient user actions (a manual PTT tap, CW,
// voice) are NOT modeled here — they go straight through handleRemotePtt; the
// arbiter guards the mode engines that hold the radio across a whole session.
const OWNERS = Object.freeze(['none', 'jtcat', 'mercury', 'js8call']);

// `js8call` is different in kind from the others and the asymmetry is
// deliberate. JTCAT and Mercury are OURS — we decide when they key, so we can
// refuse them. JS8Call is a separate application driving the radio on its own
// schedule: it answers heartbeats and directed queries whenever it likes, and
// no API command aborts a frame already going out. We cannot refuse it, only
// observe it.
//
// So it is a PREEMPTIVE owner: it always wins the acquire, and POTACAT's own
// engines wait it out. Refusing a js8call acquire would be POTACAT lying to
// itself about a transmitter that is already keyed — the far worse failure,
// because that is when POTACAT keys on top and the Flex re-points tx=1, putting
// JS8Call's audio out on POTACAT's slice and frequency.
const PREEMPTIVE = Object.freeze(['js8call']);

function isOwner(x) {
  return typeof x === 'string' && OWNERS.includes(x);
}

/** True for owners POTACAT observes rather than controls. */
function isPreemptive(x) {
  return PREEMPTIVE.includes(x);
}

/**
 * Decide whether `requester` may acquire the exclusive radio path given the
 * `current` owner. Free (`none`) or already-yours → ok; otherwise blocked.
 * @param {string} current   current owner ('none' | 'jtcat' | 'mercury')
 * @param {string} requester who wants it
 * @returns {{ok:boolean, owner:string, reason?:string, preempted?:string}}
 *   owner = resulting owner. `preempted` names whoever was displaced, so the
 *   caller can stop that engine's TX and say why — a preemption is never
 *   silent.
 */
function decideAcquire(current, requester) {
  const cur = isOwner(current) ? current : 'none';
  if (!isOwner(requester) || requester === 'none') {
    return { ok: false, owner: cur, reason: 'invalid requester' };
  }
  if (cur === 'none' || cur === requester) {
    return { ok: true, owner: requester };
  }
  // An external transmitter reporting that it is keyed. This is an observation,
  // not a request — the only correct response is to record it and get out of
  // the way.
  if (isPreemptive(requester)) {
    return { ok: true, owner: requester, preempted: cur };
  }
  return { ok: false, owner: cur, reason: `radio in use by ${cur}` };
}

/**
 * Decide the owner after `releaser` releases. Only the current owner releases
 * to 'none'; a non-owner release is a no-op (keeps the current owner). Pass
 * releaser 'force' to unconditionally clear (used on hard failsafe/quit).
 * @param {string} current
 * @param {string} releaser
 * @returns {{ok:boolean, owner:string, reason?:string}}
 */
function decideRelease(current, releaser) {
  const cur = isOwner(current) ? current : 'none';
  if (releaser === 'force') return { ok: true, owner: 'none' };
  if (cur === 'none') return { ok: true, owner: 'none' };
  if (cur === releaser) return { ok: true, owner: 'none' };
  return { ok: false, owner: cur, reason: `not owner (held by ${cur})` };
}

/** Convenience boolean: could `requester` take the radio from `current`? */
function canAcquire(current, requester) {
  return decideAcquire(current, requester).ok;
}

module.exports = { OWNERS, PREEMPTIVE, isOwner, isPreemptive, decideAcquire, decideRelease, canAcquire };
