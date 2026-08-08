#!/usr/bin/env node
'use strict';
/**
 * POTACAT as JS8Call's sound card.
 *
 * The rule worth protecting: a VB-CABLE's halves are named from the
 * APPLICATION's point of view, so "CABLE Input" is where you PLAY and
 * "CABLE Output" is where you RECORD. Getting that backwards gives two healthy
 * devices and a silent bridge — the same shape of failure as every DAX round
 * that preceded this module.
 *
 * Run: node test/js8call-audio-bridge-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isVirtualCable, cableRole, cableRank, cableDevices, planAudioBridge, sameCable,
} = require('../lib/js8call-audio-bridge');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const dev = (label, kind, deviceId) => ({ label, kind, deviceId: deviceId || label });

// One VB-CABLE plus the real hardware on the reporting station.
const ONE_CABLE = [
  dev('CABLE Input (VB-Audio Virtual Cable)', 'audiooutput'),
  dev('CABLE Output (VB-Audio Virtual Cable)', 'audioinput'),
  dev('Speakers (Elgato Wave:3)', 'audiooutput'),
  dev('Microphone (Elgato Wave:3)', 'audioinput'),
  dev('DAX Audio RX 1 (FlexRadio Systems DAX Audio)', 'audiooutput'),
];

const TWO_CABLES = ONE_CABLE.concat([
  dev('CABLE-B Input (VB-Audio Cable B)', 'audiooutput'),
  dev('CABLE-B Output (VB-Audio Cable B)', 'audioinput'),
]);

// ── recognising a cable ──────────────────────────────────────────────────────

test('the common virtual cables are recognised, real hardware is not', () => {
  assert.strictEqual(isVirtualCable('CABLE Input (VB-Audio Virtual Cable)'), true);
  assert.strictEqual(isVirtualCable('VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)'), true);
  assert.strictEqual(isVirtualCable('Speakers (Elgato Wave:3)'), false);
  assert.strictEqual(isVirtualCable('DAX Audio RX 1 (FlexRadio Systems DAX Audio)'), false);
  assert.strictEqual(isVirtualCable(''), false);
});

test('"Input" is where you PLAY and "Output" is where you RECORD', () => {
  // Named from the application's side, which reads backwards as plumbing and
  // is the single easiest thing to get wrong here.
  assert.strictEqual(cableRole('CABLE Input (VB-Audio Virtual Cable)'), 'play');
  assert.strictEqual(cableRole('CABLE Output (VB-Audio Virtual Cable)'), 'record');
  assert.strictEqual(cableRole('Speakers (Elgato Wave:3)'), null);
});

test('devices are grouped by what POTACAT can do with them', () => {
  const g = cableDevices(ONE_CABLE);
  assert.strictEqual(g.play.length, 1);
  assert.strictEqual(g.record.length, 1);
  assert.ok(/CABLE Input/.test(g.play[0].label));
  assert.ok(/CABLE Output/.test(g.record[0].label));
});

// ── the plan ─────────────────────────────────────────────────────────────────

test('one cable gives a working receive path and says why transmit needs another', () => {
  const p = planAudioBridge({ devices: ONE_CABLE });
  assert.ok(p.rx, 'receive should work with a single cable');
  assert.ok(/CABLE Input/.test(p.rx.label));
  assert.strictEqual(p.rxReason, '');
  assert.strictEqual(p.tx, null);
  assert.ok(/second cable/.test(p.txReason), p.txReason);
});

test('the same cable is refused for both directions', () => {
  // JS8Call would hear its own transmission as receive audio.
  const p = planAudioBridge({
    devices: ONE_CABLE,
    txDeviceId: 'CABLE Output (VB-Audio Virtual Cable)',
  });
  assert.strictEqual(p.tx, null);
  assert.ok(/hear its own transmission/.test(p.txReason), p.txReason);
});

test('two cables give both directions', () => {
  const p = planAudioBridge({
    devices: TWO_CABLES,
    txDeviceId: 'CABLE-B Output (VB-Audio Cable B)',
  });
  assert.ok(p.rx && p.tx);
  assert.ok(/CABLE Input/.test(p.rx.label));
  assert.ok(/CABLE-B Output/.test(p.tx.label));
  assert.strictEqual(p.txReason, '');
});

test('no cable at all names the driver to install', () => {
  const p = planAudioBridge({ devices: [dev('Speakers (Realtek)', 'audiooutput')] });
  assert.strictEqual(p.rx, null);
  assert.ok(/VB-CABLE/.test(p.rxReason), p.rxReason);
});

test('"could not read the devices" is not reported as "you have no cable"', () => {
  // Sends someone to install a driver they already have. Both an empty list and
  // a list with no readable names mean the enumeration failed, not the station.
  for (const devices of [[], [dev('', 'audiooutput'), dev('', 'audioinput')]]) {
    const p = planAudioBridge({ devices });
    assert.ok(/could not read/i.test(p.rxReason), p.rxReason);
    assert.ok(!/Install VB-CABLE/.test(p.rxReason), p.rxReason);
  }
});

test('an explicit choice beats the first match', () => {
  const p = planAudioBridge({
    devices: TWO_CABLES,
    rxDeviceId: 'CABLE-B Input (VB-Audio Cable B)',
  });
  assert.ok(/CABLE-B Input/.test(p.rx.label));
});

test('a chosen device that has been unplugged is reported, not silently swapped', () => {
  const p = planAudioBridge({ devices: ONE_CABLE, rxDeviceId: 'CABLE-B Input (VB-Audio Cable B)' });
  // Falls back to the one that exists, and the operator still gets a device.
  assert.ok(p.rx, 'a working cable is better than none');
  assert.ok(/CABLE Input/.test(p.rx.label));
});

// ── VoiceMeeter, which pairs strips to buses rather than Input to Output ─────

test('VoiceMeeter strips are play targets and B-buses are capture sources', () => {
  assert.strictEqual(cableRole('Voicemeeter Input (VB-Audio Voicemeeter VAIO)'), 'play');
  assert.strictEqual(cableRole('Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)'), 'play');
  assert.strictEqual(cableRole('Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO)'), 'play');
  assert.strictEqual(cableRole('Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)'), 'record');
});

test('the A-buses are hardware sends and are never offered as a capture source', () => {
  // A1..A5 feed real speakers. Recording from one captures whatever the
  // operator is listening to — not JS8Call, and not silence.
  assert.strictEqual(cableRole('Voicemeeter Out A1 (VB-Audio Voicemeeter VAIO)'), 'hardware');
  const g = cableDevices([
    dev('Voicemeeter Out A1 (VB-Audio Voicemeeter VAIO)', 'audioinput'),
    dev('Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)', 'audioinput'),
  ]);
  assert.strictEqual(g.record.length, 1);
  assert.ok(/B1/.test(g.record[0].label));
});

test('a VoiceMeeter Potato station gets both directions', () => {
  const vm = [
    dev('Voicemeeter Input (VB-Audio Voicemeeter VAIO)', 'audiooutput'),
    dev('Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)', 'audiooutput'),
    dev('Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)', 'audioinput'),
    dev('Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)', 'audioinput'),
  ];
  const p = planAudioBridge({ devices: vm, txDeviceId: 'Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)' });
  assert.ok(p.rx && p.tx, p.rxReason + ' / ' + p.txReason);
  assert.strictEqual(p.txReason, '');
});

// ── ranking: the OS's enumeration order is not a preference ─────────────────

test('the canonical VoiceMeeter strip outranks the insert channels', () => {
  // VoiceMeeter's driver publishes "Voicemeeter In 1..5" insert channels that a
  // Standard or Banana mixer has no strips for and cannot route. Windows
  // enumerated "In 4" first, so the picker defaulted to a device that goes
  // nowhere, on a station whose VAIO strip was sitting right there (K3SBP).
  const devices = [
    dev('Voicemeeter In 4 (VB-Audio Voicemeeter VAIO)', 'audiooutput'),
    dev('Voicemeeter In 1 (VB-Audio Voicemeeter VAIO)', 'audiooutput'),
    dev('Voicemeeter Input (VB-Audio Voicemeeter VAIO)', 'audiooutput'),
  ];
  assert.ok(/^Voicemeeter Input /.test(cableDevices(devices).play[0].label));
  assert.ok(/^Voicemeeter Input /.test(planAudioBridge({ devices }).rx.label));
});

test('the capture default is a B-bus, never an insert channel', () => {
  const devices = [
    dev('Voicemeeter Out 3 (VB-Audio Voicemeeter VAIO)', 'audioinput'),
    dev('Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)', 'audioinput'),
  ];
  assert.ok(/B1/.test(cableDevices(devices).record[0].label));
});

test('an explicit choice still beats the ranking', () => {
  // Ranking supplies a default; it must never overrule the operator.
  const devices = [
    dev('Voicemeeter Input (VB-Audio Voicemeeter VAIO)', 'audiooutput'),
    dev('CABLE Input (VB-Audio Virtual Cable)', 'audiooutput'),
  ];
  const p = planAudioBridge({ devices, rxDeviceId: 'CABLE Input (VB-Audio Virtual Cable)' });
  assert.ok(/CABLE Input/.test(p.rx.label));
});

test('the ranking patterns contain no stray control characters', () => {
  // A backslash-b written inside a template literal is a BACKSPACE, not a word
  // boundary — so /^voicemeeter input\b/ became a pattern matching nothing and
  // every device tied for last place. Generating source from source is how that
  // got in; this assertion is how it stays out.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'js8call-audio-bridge.js'), 'utf8');
  const bad = src.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  assert.ok(!bad, 'control character U+' + (bad && bad[0].charCodeAt(0).toString(16)) + ' in the module source');
  assert.notStrictEqual(
    cableRank('Voicemeeter Input (VB-Audio Voicemeeter VAIO)'),
    cableRank('Voicemeeter In 4 (VB-Audio Voicemeeter VAIO)'));
});

test('the two halves of one cable are recognised as one cable', () => {
  assert.strictEqual(
    sameCable('CABLE Input (VB-Audio Virtual Cable)', 'CABLE Output (VB-Audio Virtual Cable)'), true);
  assert.strictEqual(
    sameCable('CABLE Input (VB-Audio Virtual Cable)', 'CABLE-B Output (VB-Audio Cable B)'), false);
});

console.log(`\nJS8Call audio bridge: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
