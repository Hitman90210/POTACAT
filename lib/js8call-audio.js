// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Matching JS8Call's audio devices to the ones the machine actually has.
//
// WHY THIS EXISTS. js8call-process.js used to compose device names from a
// template — `DAX Audio RX ${n} (FlexRadio Systems DAX Audio)` and
// `DAX Audio TX (FlexRadio Systems DAX TX)`. On K3SBP's station (2026-08-06)
// the transmit endpoint is called `DAX RESERVED AUDIO TX (FlexRadio Systems
// DAX TX)` and there is no `DAX Audio RX 4` at all, so the template produced
// names for devices that do not exist and JS8Call answered with "Requested
// output audio format is not supported on device" — a message that describes
// a format problem and is really a missing device.
//
// Same lesson as the preamp/ATT ladders in lib/rig-gain-steps.js: ask the
// hardware what it has, never assume the shape. A guessed name that happens to
// be right on one machine is indistinguishable from a correct one until it
// isn't.
//
// Pure: takes a list of device labels (whatever enumerateDevices reported) and
// answers questions about it. No I/O, no Electron.

'use strict';

/**
 * What kind of DAX endpoint a label names, if any.
 *
 * Order matters. `DAX IQ RX 1 (FlexRadio Systems DAX IQ)` contains "RX 1" and
 * would otherwise be picked as a receive-audio channel — it is raw I/Q and
 * feeding it to a decoder produces silence, not an error.
 *
 * @param {string} label
 * @returns {{kind:'rx'|'tx'|'mic'|'iq'|null, channel:number|null}}
 */
function parseDaxLabel(label) {
  const s = String(label || '');
  if (!/\bDAX\b/i.test(s)) return { kind: null, channel: null };
  if (/\bDAX\s+IQ\b/i.test(s) || /DAX IQ\)/i.test(s)) {
    const m = s.match(/RX\s*(\d+)/i);
    return { kind: 'iq', channel: m ? Number(m[1]) : null };
  }
  if (/\bMIC\b/i.test(s)) return { kind: 'mic', channel: null };
  const rx = s.match(/\bRX\s*(\d+)\b/i);
  if (rx) return { kind: 'rx', channel: Number(rx[1]) };
  if (/\bTX\b/i.test(s)) return { kind: 'tx', channel: null };
  return { kind: null, channel: null };
}

/** Every DAX receive-audio channel this machine actually presents, ascending. */
function daxRxChannels(labels) {
  const out = new Set();
  for (const l of labels || []) {
    const p = parseDaxLabel(l);
    if (p.kind === 'rx' && p.channel) out.add(p.channel);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The real label for a given DAX RX channel within ONE driver family, or null.
 *
 * The longest-name tiebreak is only a within-family nicety. It must NOT be used
 * to choose between the two DAX generations — the stale family has the longer,
 * more official-looking names and is the dead one. resolveDaxPair() picks the
 * family first, from the transmit endpoint, and passes only that family here.
 */
function pickDaxRx(labels, channel) {
  const hits = (labels || []).filter((l) => {
    const p = parseDaxLabel(l);
    return p.kind === 'rx' && p.channel === Number(channel);
  });
  if (!hits.length) return null;
  return hits.sort((a, b) => b.length - a.length)[0];
}

/**
 * Is this endpoint a placeholder rather than a usable device?
 *
 * FlexRadio's driver publishes `DAX RESERVED AUDIO TX` when DAX has not been
 * provisioned. It enumerates like any other endpoint — Windows lists it, its
 * status is OK, and a name-presence check passes it — but nothing can open it,
 * and Qt reports that as "Requested output audio format is not supported on
 * device". The word RESERVED is the only thing separating it from the real
 * device, which is why this exists rather than trusting enumeration alone.
 * (K3SBP 2026-08-06: the DAX control panel was not running.)
 */
function isPlaceholderDax(label) {
  return /\bRESERVED\b/i.test(String(label || ''));
}

/** The real transmit-audio label, or null. A placeholder is not an answer. */
function pickDaxTx(labels) {
  const hits = (labels || [])
    .filter((l) => parseDaxLabel(l).kind === 'tx' && !isPlaceholderDax(l));
  if (!hits.length) return null;
  return hits.sort((a, b) => b.length - a.length)[0];
}

/** The driver name in a DAX label's trailing parenthetical. */
function daxDriverFamily(label) {
  const m = String(label || '').match(/\(([^)]*)\)\s*$/);
  return m ? m[1].trim() : '';
}

/**
 * Which generation of the DAX driver a label belongs to.
 *
 * BOTH can be installed at once and both enumerate — K3SBP's station has the
 * legacy `(FlexRadio DAX)` set that SmartSDR v4.2 actually drives, alongside a
 * stale `(FlexRadio Systems DAX …)` set left by an older install. The stale set
 * looks healthier at a glance (longer, more official names) and is completely
 * inert: its transmit endpoint is the RESERVED placeholder and its `DAX Audio
 * RX 4` does not exist at all.
 */
function daxFamilyKind(label) {
  const f = daxDriverFamily(label);
  if (!f) return '';
  return /^FlexRadio\s+Systems\b/i.test(f) ? 'systems' : 'legacy';
}

/**
 * Resolve the receive and transmit devices TOGETHER, from one driver family.
 *
 * They cannot be chosen independently: picking RX from one generation and TX
 * from the other gives JS8Call two devices that are not connected to the same
 * radio plumbing. The usable TX endpoint identifies the live family — a family
 * whose transmit device is only the RESERVED placeholder is not running —
 * and the RX channel is then taken from that same family.
 *
 * @returns {{tx:string|null, rx:string|null, channel:number|null, family:string}}
 */
function resolveDaxPair(labels, { taken = [], preferred = 0 } = {}) {
  const tx = pickDaxTx(labels);
  if (!tx) return { tx: null, rx: null, channel: null, family: '' };
  const kind = daxFamilyKind(tx);
  const kin = (labels || []).filter((l) => daxFamilyKind(l) === kind);
  const channel = chooseDaxRxChannel(kin, taken, preferred);
  return {
    tx,
    rx: channel ? pickDaxRx(kin, channel) : null,
    channel,
    family: daxDriverFamily(tx),
  };
}

/**
 * Has DAX actually been provisioned on this machine?
 *
 * The transmit endpoint is the tell: a real one means the DAX control panel is
 * running and has bound to the radio; only the RESERVED placeholder means it is
 * not, and then EVERY DAX endpoint is inert — the receive ones look perfectly
 * normal and simply carry no audio.
 *
 * Returns null when the device list is empty, because "we could not look" and
 * "we looked and DAX is down" must not produce the same advice.
 */
function daxProvisioned(labels) {
  if (!labels || !labels.length) return null;
  const anyDax = labels.some((l) => parseDaxLabel(l).kind);
  if (!anyDax) return null;                 // no DAX driver at all: not our story
  return pickDaxTx(labels) !== null;
}

/**
 * Which DAX RX channel JS8Call should use: the lowest one that EXISTS on this
 * machine and is not already spoken for.
 *
 * Existence is the part the old arithmetic missed. "slice B means DAX 2" is a
 * convention; whether DAX 2 is present is a fact, and only the fact can be
 * written into a config file.
 *
 * @param {string[]} labels    device labels present
 * @param {number[]} taken     channels POTACAT is already using
 * @param {number}   preferred first choice, if it happens to be free and real
 * @returns {number|null}
 */
function chooseDaxRxChannel(labels, taken = [], preferred = 0) {
  const have = daxRxChannels(labels);
  if (!have.length) return null;
  const busy = new Set((taken || []).map(Number).filter(Boolean));
  if (preferred && have.includes(Number(preferred)) && !busy.has(Number(preferred))) {
    return Number(preferred);
  }
  return have.find((c) => !busy.has(c)) ?? null;
}

/**
 * Is a device JS8Call is configured to open actually present?
 *
 * Compared case-insensitively on trimmed text: JS8Call stores the endpoint's
 * friendly name verbatim, so an exact match is the honest test — a fuzzy one
 * would report "present" for a device Qt will still fail to open.
 */
function deviceMissing(configured, labels) {
  const want = String(configured || '').trim();
  if (!want) return false;      // nothing configured is not a missing device
  const norm = (s) => String(s).trim().toLowerCase();
  return !(labels || []).some((l) => norm(l) === norm(want));
}

/**
 * Why a device JS8Call is configured to open will not work — or null if it will.
 *
 * `deviceMissing` only answers "is this string in the list", and that is not the
 * same question. Both of the devices JS8Call was pointed at on K3SBP's station
 * enumerated perfectly and neither could carry audio:
 *
 *   DAX RESERVED AUDIO TX (…)              a placeholder; cannot be opened
 *   DAX Audio RX 2 (FlexRadio Systems …)   real, opens, from the dead driver
 *                                          generation — silence, no error
 *
 * So POTACAT reported "JS8Call is ready" and started it into the same failure.
 * A check that only detects absence cannot see either of these.
 *
 * @returns {'missing'|'placeholder'|'dead-family'|null}
 */
function deviceProblem(configured, labels) {
  const want = String(configured || '').trim();
  if (!want) return null;
  if (deviceMissing(want, labels)) return 'missing';
  if (isPlaceholderDax(want)) return 'placeholder';
  const kind = daxFamilyKind(want);
  if (kind) {
    const live = pickDaxTx(labels);
    // No live TX at all means DAX is down, which is a different diagnosis and
    // has its own screen — do not also accuse the device of being stale.
    if (live && daxFamilyKind(live) !== kind) return 'dead-family';
  }
  return null;
}

/** One plain sentence per problem, for the operator. */
function describeDeviceProblem(device, why) {
  switch (why) {
    case 'missing':
      return `${device} is not on this PC.`;
    case 'placeholder':
      return `${device} is a placeholder, not a real device — nothing can open it.`;
    case 'dead-family':
      return `${device} belongs to an old DAX driver that is no longer the active one, so it opens but carries no audio.`;
    default:
      return `${device} cannot be used.`;
  }
}

module.exports = {
  parseDaxLabel,
  daxRxChannels,
  pickDaxRx,
  pickDaxTx,
  chooseDaxRxChannel,
  deviceMissing,
  isPlaceholderDax,
  daxProvisioned,
  daxDriverFamily,
  daxFamilyKind,
  resolveDaxPair,
  deviceProblem,
  describeDeviceProblem,
};
