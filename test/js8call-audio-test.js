#!/usr/bin/env node
'use strict';
/**
 * Matching JS8Call's audio devices to the ones a machine actually has.
 *
 * The fixture is K3SBP's real render-endpoint list (2026-08-06), warts kept:
 * the transmit device is called "DAX RESERVED AUDIO TX", not "DAX Audio TX",
 * and DAX RX 4 is simply absent. Both facts broke the template that used to
 * compose these names, and both are the reason this module exists.
 *
 * Run: node test/js8call-audio-test.js
 */

const assert = require('assert');
const {
  parseDaxLabel, daxRxChannels, pickDaxRx, pickDaxTx, chooseDaxRxChannel, deviceMissing,
} = require('../lib/js8call-audio');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// Verbatim from Get-PnpDevice -Class AudioEndpoint on the reporting station.
const REAL = [
  'DAX Audio RX 1 (FlexRadio Systems DAX Audio)',
  'DAX Audio RX 2 (FlexRadio Systems DAX Audio)',
  'DAX Audio RX 3 (FlexRadio Systems DAX Audio)',
  // no RX 4 — this gap is the point
  'DAX Audio RX 5 (FlexRadio Systems DAX Audio)',
  'DAX Audio RX 6 (FlexRadio Systems DAX Audio)',
  'DAX Audio RX 7 (FlexRadio Systems DAX Audio)',
  'DAX Audio RX 8 (FlexRadio Systems DAX Audio)',
  'DAX IQ RX 1 (FlexRadio Systems DAX IQ)',
  'DAX IQ RX 2 (FlexRadio Systems DAX IQ)',
  'DAX MIC Audio (FlexRadio Systems DAX MIC Audio)',
  'DAX RESERVED AUDIO TX (FlexRadio Systems DAX TX)',
  'Speakers (Elgato Wave:3)',
  'VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)',
];

// ── classification ───────────────────────────────────────────────────────────

test('I/Q is not a receive-audio channel, despite saying "RX 1"', () => {
  // Feeding raw I/Q to a decoder yields silence, not an error — the worst
  // possible failure, because nothing reports it.
  assert.deepStrictEqual(parseDaxLabel('DAX IQ RX 1 (FlexRadio Systems DAX IQ)'),
    { kind: 'iq', channel: 1 });
  assert.deepStrictEqual(parseDaxLabel('DAX Audio RX 1 (FlexRadio Systems DAX Audio)'),
    { kind: 'rx', channel: 1 });
});

test('the transmit endpoint is recognised under a name nobody predicted', () => {
  assert.strictEqual(parseDaxLabel('DAX RESERVED AUDIO TX (FlexRadio Systems DAX TX)').kind, 'tx');
  assert.strictEqual(parseDaxLabel('DAX Audio TX (FlexRadio Systems DAX TX)').kind, 'tx');
  assert.strictEqual(parseDaxLabel('DAX TX (FlexRadio DAX)').kind, 'tx');
});

test('mic is its own thing, and a non-DAX device is nothing', () => {
  assert.strictEqual(parseDaxLabel('DAX MIC Audio (FlexRadio Systems DAX MIC Audio)').kind, 'mic');
  assert.deepStrictEqual(parseDaxLabel('Speakers (Elgato Wave:3)'), { kind: null, channel: null });
  assert.deepStrictEqual(parseDaxLabel(''), { kind: null, channel: null });
  assert.deepStrictEqual(parseDaxLabel(null), { kind: null, channel: null });
});

// ── what the machine really has ──────────────────────────────────────────────

test('channel list reports the gap instead of assuming 1..8', () => {
  assert.deepStrictEqual(daxRxChannels(REAL), [1, 2, 3, 5, 6, 7, 8]);
});

test('a real label is returned, never reconstructed', () => {
  assert.strictEqual(pickDaxRx(REAL, 2), 'DAX Audio RX 2 (FlexRadio Systems DAX Audio)');
  assert.strictEqual(pickDaxRx(REAL, 4), null, 'RX 4 is absent — say so rather than invent it');
  assert.strictEqual(pickDaxTx(REAL), 'DAX RESERVED AUDIO TX (FlexRadio Systems DAX TX)');
});

test('when both DAX driver generations are installed, the fuller name wins', () => {
  const both = ['DAX RX 2 (FlexRadio DAX)', 'DAX Audio RX 2 (FlexRadio Systems DAX Audio)'];
  assert.strictEqual(pickDaxRx(both, 2), 'DAX Audio RX 2 (FlexRadio Systems DAX Audio)');
});

test('no DAX at all returns nothing, not a guess', () => {
  assert.strictEqual(pickDaxRx(['Speakers (Realtek)'], 1), null);
  assert.strictEqual(pickDaxTx(['Speakers (Realtek)']), null);
  assert.deepStrictEqual(daxRxChannels([]), []);
});

// ── choosing a channel ───────────────────────────────────────────────────────

test('the preferred channel is honoured when it exists and is free', () => {
  assert.strictEqual(chooseDaxRxChannel(REAL, [1], 2), 2);
});

test('a preferred channel that does not exist falls through to one that does', () => {
  // "slice D means DAX 4" is a convention; DAX 4 being present is a fact.
  assert.strictEqual(chooseDaxRxChannel(REAL, [1], 4), 2);
});

test('POTACAT\'s own channel is never handed to JS8Call', () => {
  assert.strictEqual(chooseDaxRxChannel(REAL, [1, 2, 3], 2), 5,
    'must skip the taken ones AND the missing 4');
});

test('every channel taken yields null rather than a collision', () => {
  assert.strictEqual(chooseDaxRxChannel(REAL, [1, 2, 3, 5, 6, 7, 8], 2), null);
  assert.strictEqual(chooseDaxRxChannel([], [], 1), null);
});

// ── the check that would have caught this ────────────────────────────────────

test('a configured device that is not present is reported missing', () => {
  // The exact bug: JS8Call said "Requested output audio format is not
  // supported on device" for a device that simply was not there.
  assert.strictEqual(deviceMissing('DAX Audio TX (FlexRadio Systems DAX TX)', REAL), true);
  assert.strictEqual(deviceMissing('DAX RESERVED AUDIO TX (FlexRadio Systems DAX TX)', REAL), false);
});

test('matching is exact-but-forgiving of case and padding, not fuzzy', () => {
  assert.strictEqual(deviceMissing('  dax audio rx 2 (flexradio systems dax audio)  ', REAL), false);
  // Fuzzy matching would call this present; Qt would still fail to open it.
  assert.strictEqual(deviceMissing('DAX Audio RX 2', REAL), true);
});

test('nothing configured is not a missing device', () => {
  assert.strictEqual(deviceMissing('', REAL), false);
  assert.strictEqual(deviceMissing(null, REAL), false);
});

test('an empty device list makes no claim about anything', () => {
  // Headless, or enumeration failed. Reporting everything as missing would
  // bury the operator in false alarms.
  assert.strictEqual(deviceMissing('DAX Audio TX (FlexRadio Systems DAX TX)', []), true);
});

console.log(`\nJS8Call audio: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
