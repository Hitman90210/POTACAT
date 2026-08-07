// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Giving JS8Call its own receiver on a multi-slice Flex.
//
// WHY. On a single-slice station there is exactly one DAX audio channel with a
// slice bound to it, and POTACAT is already streaming it — so JS8Call gets a
// device that opens and delivers silence. A Flex 8600 supports four slices, so
// the honest fix is not to fight over one channel but to create a second
// receiver, bind it to a free DAX channel, and let JS8Call have it outright.
// POTACAT is the GUI client (or bound to one) and can do this over the API.
//
// Pure: every decision here is arithmetic over facts the caller supplies —
// which slices exist, which DAX channels are spoken for, what the radio can do.
// No sockets, so the rules are testable without a radio.
//
// Command syntax comes from FlexRadio's own API wiki (TCPIP-slice):
//   slice create [freq=<MHz>][pan=<streamID>][ant=<port>][mode=<mode>]
//   slice r <slice_rx>
//   slice s <slice_rx> <param=value>...

'use strict';

/** DAX audio channels a Flex exposes. Channel 0 means "off", never a target. */
const DAX_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Default JS8 dial frequencies, MHz. JS8Call's own convention; POTACAT only
 * needs a sensible place to put a brand-new slice, and the operator retunes it
 * from JS8Call or POTACAT afterwards.
 */
const JS8_DIAL_MHZ = Object.freeze({
  160: 1.842, 80: 3.578, 60: 5.357, 40: 7.078, 30: 10.130,
  20: 14.078, 17: 18.104, 15: 21.078, 12: 24.922, 10: 28.078, 6: 50.318,
});

/** The Flex mode name for JS8 — upper-sideband data, not plain USB. */
const JS8_MODE = 'DIGU';

/**
 * The lowest DAX channel not already bound to a slice.
 *
 * "Free" means no slice feeds it. A channel bound to nothing is not a spare —
 * it is a device that opens and carries silence, which is the failure this
 * whole module exists to avoid.
 *
 * @param {number[]} used   channels already bound (smartSdr.usedDaxChannels)
 * @param {number}   maxCh  how many channels this radio serves
 * @returns {number|null}
 */
function freeDaxChannel(used = [], maxCh = 8) {
  const busy = new Set((used || []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const ch = DAX_CHANNELS.filter((c) => c <= maxCh).find((c) => !busy.has(c));
  return ch === undefined ? null : ch;
}

/**
 * May POTACAT create another slice, and if not, why not?
 *
 * Refusing with a reason matters more than the boolean: "no free slice" and
 * "POTACAT is not the GUI client" need completely different actions from the
 * operator, and a bare false sends them looking in the wrong place.
 *
 * @param {{slices:number[], maxSlices:number, canControl:boolean, usedDax:number[]}} o
 * @returns {{ok:boolean, reason:string, daxChannel:number|null}}
 */
function canCreateSlice({ slices = [], maxSlices = 4, canControl = true, usedDax = [] } = {}) {
  if (!canControl) {
    return { ok: false, reason: 'POTACAT is not controlling the radio right now.', daxChannel: null };
  }
  if (slices.length >= maxSlices) {
    return {
      ok: false,
      daxChannel: null,
      reason: `The radio already has all ${maxSlices} of its slices in use. Close one and try again.`,
    };
  }
  const daxChannel = freeDaxChannel(usedDax, 8);
  if (!daxChannel) {
    return { ok: false, reason: 'Every DAX channel is already bound to a slice.', daxChannel: null };
  }
  return { ok: true, reason: '', daxChannel };
}

/**
 * Where to put JS8Call's new slice.
 *
 * Prefers the JS8 dial for the band POTACAT is already on, so the new receiver
 * lands where the operator is actually listening rather than on a band they are
 * not using. Falls back to 20 m, which is where JS8 traffic mostly is.
 */
function js8SliceFreq(currentHz, fallbackBand = 20) {
  const band = bandForHz(currentHz);
  if (band && JS8_DIAL_MHZ[band]) return JS8_DIAL_MHZ[band];
  return JS8_DIAL_MHZ[fallbackBand] || JS8_DIAL_MHZ[20];
}

/** Coarse band lookup, enough to choose a JS8 dial. */
function bandForHz(hz) {
  const mhz = Number(hz) / 1e6;
  if (!mhz || !isFinite(mhz)) return null;
  const bands = [
    [1.8, 2.0, 160], [3.5, 4.0, 80], [5.3, 5.4, 60], [7.0, 7.3, 40],
    [10.1, 10.15, 30], [14.0, 14.35, 20], [18.06, 18.17, 17], [21.0, 21.45, 15],
    [24.89, 24.99, 12], [28.0, 29.7, 10], [50.0, 54.0, 6],
  ];
  const hit = bands.find(([lo, hi]) => mhz >= lo && mhz <= hi);
  return hit ? hit[2] : null;
}

/**
 * The full plan, as data, before anything is sent to the radio.
 *
 * Returned rather than executed so the panel can show it and main.js can run
 * it — the same confirm-before-acting shape the ini patcher uses, and for the
 * same reason: this changes the operator's radio.
 */
function planJs8Slice({ slices = [], maxSlices = 4, canControl = true, usedDax = [], currentHz = 0 } = {}) {
  const gate = canCreateSlice({ slices, maxSlices, canControl, usedDax });
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const freq = js8SliceFreq(currentHz);
  return {
    ok: true,
    reason: '',
    daxChannel: gate.daxChannel,
    freq,
    mode: JS8_MODE,
    steps: [
      `Create a receiver on ${freq.toFixed(3)} MHz ${JS8_MODE}`,
      `Bind it to DAX channel ${gate.daxChannel}`,
      `Point JS8Call at DAX RX ${gate.daxChannel}`,
    ],
  };
}

module.exports = {
  DAX_CHANNELS,
  JS8_DIAL_MHZ,
  JS8_MODE,
  freeDaxChannel,
  canCreateSlice,
  js8SliceFreq,
  bandForHz,
  planJs8Slice,
};
