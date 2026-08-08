// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// POTACAT as JS8Call's sound card.
//
// WHY THIS EXISTS. JTCAT, SSTV and voice all reach a Flex without SmartSDR,
// DAX, or any Windows audio device: POTACAT generates their audio and streams
// it to the radio as VITA-49 dax_rx/dax_tx. It IS the sound card. JS8Call
// cannot use that path — it is a separate Windows application that speaks only
// to Windows audio devices and has no network audio.
//
// That leaves exactly two routes and no third:
//
//   DAX      JS8Call -> DAX device -> DAX program -> radio
//            needs SmartSDR running, the DAX program running, a spare slice,
//            and the SmartSDR DAX button on. Four moving parts POTACAT can
//            neither see nor control, and one wrong leaves a silent carrier.
//
//   cable    JS8Call -> virtual cable -> POTACAT -> VITA-49
//            needs one passive driver, installed once, with no UI and nothing
//            to switch on. TX then rides the same dax_tx path JTCAT already
//            uses successfully on this station.
//
// The second is a smaller dependency, not a larger one, and it is the only one
// that works on a SmartSDR-less station. (K3SBP 2026-08-07, after two days in
// which every DAX failure was real and none of them was the last one.)
//
// Pure: device matching and plan decisions only. No audio, no Electron.

'use strict';

/**
 * Virtual audio cables, by the vendor strings they actually present.
 *
 * Matched on substrings rather than exact names because every one of these
 * ships several endpoint variants, and this whole integration has already been
 * burned twice by composing a device name instead of recognising one.
 */
const CABLE_HINTS = [
  'vb-audio', 'cable input', 'cable output', 'virtual cable',
  'voicemeeter', 'vac ', 'virtual audio',
];

/** Is this device one of the virtual cables we know how to use? */
function isVirtualCable(label) {
  const s = String(label || '').toLowerCase();
  return CABLE_HINTS.some((h) => s.includes(h));
}

/**
 * The two halves of a VB-CABLE, which are named from the APPLICATION's point
 * of view and therefore read backwards from the plumbing:
 *
 *   "CABLE Input"  is a RENDER device — applications PLAY into it.
 *   "CABLE Output" is a CAPTURE device — applications RECORD from it.
 *
 * So POTACAT plays receive audio to a "CABLE Input", and JS8Call records it
 * from the matching "CABLE Output". Getting this backwards produces a silent
 * bridge with two perfectly healthy devices, which is precisely the failure
 * mode this module exists to stop repeating.
 */
function cableRole(label) {
  const s = String(label || '').toLowerCase();
  if (!isVirtualCable(s)) return null;
  if (s.includes('cable input') || s.includes('voicemeeter input')) return 'play';
  if (s.includes('cable output') || s.includes('voicemeeter output')) return 'record';
  return 'unknown';
}

/** Group a device list into what POTACAT can play to and record from. */
function cableDevices(devices) {
  const list = (devices || []).filter((d) => d && d.label);
  return {
    play: list.filter((d) => d.kind === 'audiooutput' && isVirtualCable(d.label)),
    record: list.filter((d) => d.kind === 'audioinput' && isVirtualCable(d.label)),
  };
}

/**
 * Decide the bridge, or say exactly what is missing.
 *
 * RX and TX are reported separately because RX alone is genuinely useful — it
 * needs one cable and no radio changes at all — while TX needs a second one.
 * Collapsing them into a single ok/not-ok would hide a working half.
 *
 * @param {{devices:Array, rxDeviceId?:string, txDeviceId?:string}} o
 */
function planAudioBridge({ devices = [], rxDeviceId = '', txDeviceId = '' } = {}) {
  const found = cableDevices(devices);
  const byId = (arr, id) => arr.find((d) => d.deviceId === id) || null;

  // Explicit choice always wins; otherwise take the first cable of each kind.
  const rx = (rxDeviceId && byId(found.play, rxDeviceId)) || found.play[0] || null;
  const tx = (txDeviceId && byId(found.record, txDeviceId)) || null;

  const out = {
    rx: rx ? { deviceId: rx.deviceId, label: rx.label } : null,
    tx: tx ? { deviceId: tx.deviceId, label: tx.label } : null,
    cables: { play: found.play.length, record: found.record.length },
    rxReason: '',
    txReason: '',
  };

  if (!found.play.length) {
    out.rxReason = 'No virtual audio cable found. Install VB-CABLE (vb-audio.com) — one driver, nothing to configure.';
  } else if (!rx) {
    out.rxReason = 'The chosen playback cable is no longer present.';
  }

  if (!tx) {
    // A record device on the SAME cable as rx is not a candidate — it is the
    // other end of the wire already carrying receive audio. With only one cable
    // installed there is therefore nothing to offer, however many endpoints it
    // presents.
    const usable = found.record.filter((d) => !rx || !sameCable(rx.label, d.label));
    out.txReason = usable.length
      ? 'Pick which cable JS8Call transmits into. It must be a DIFFERENT cable from the receive one, or its own transmit audio comes straight back as receive.'
      : 'Transmitting also needs a second cable — the receive one is busy carrying audio the other way.';
  } else if (rx && sameCable(rx.label, tx.label)) {
    // One cable cannot carry both directions: JS8Call would hear itself.
    out.tx = null;
    out.txReason = 'That is the same cable used for receive, so JS8Call would hear its own transmission. Use a second cable.';
  }
  return out;
}

/** Do two endpoint labels belong to the same cable? ("CABLE Input"/"CABLE Output") */
function sameCable(a, b) {
  const strip = (s) => String(s || '').toLowerCase()
    .replace(/\b(input|output)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
  return strip(a) === strip(b);
}

module.exports = {
  CABLE_HINTS,
  isVirtualCable,
  cableRole,
  cableDevices,
  planAudioBridge,
  sameCable,
};
