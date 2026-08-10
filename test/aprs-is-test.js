#!/usr/bin/env node
'use strict';
// APRS-IS gateway — pure packet builders. The wire format is unforgiving
// (malformed packets are dropped SILENTLY by the backbone), so these pins are
// the difference between "gated" and "vanished". Run: node test/aprs-is-test.js

const assert = require('assert');
const { aprsPasscode, buildGatePacket, gridToAprsLatLon, buildPositionPacket } = require('../lib/aprs-is');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('passcode matches the public algorithm', () => {
  // Known vectors any APRS tool reproduces.
  assert.strictEqual(aprsPasscode('N0CALL'), 13023);
  assert.strictEqual(aprsPasscode('n0call-5'), 13023, 'SSID stripped, case-insensitive');
  assert.strictEqual(aprsPasscode(''), -1);
});

test('gate packet: source stays the RF sender, we vouch via qAR', () => {
  assert.strictEqual(
    buildGatePacket('W1AW', 'K3SBP', ':SMSGTE   :@15551234567 hi{01'),
    'W1AW>APZJS8,TCPIP*,qAR,K3SBP::SMSGTE   :@15551234567 hi{01');
  assert.strictEqual(buildGatePacket('', 'K3SBP', 'x'), null, 'no source, no packet');
  assert.strictEqual(buildGatePacket('W1AW', 'K3SBP', ''), null, 'no payload, no packet');
  assert.ok(!buildGatePacket('W1AW', 'K3SBP', 'a\r\nb').includes('\n'), 'newlines can never split a packet');
});

test('grid to APRS position: FN20 centers the square', () => {
  const p = gridToAprsLatLon('FN20');
  assert.strictEqual(p.lat, '4030.00N');
  assert.strictEqual(p.lon, '07500.00W');
  assert.strictEqual(gridToAprsLatLon('AA00').lat, '8930.00S');
  assert.strictEqual(gridToAprsLatLon('XX99'), null, 'field letters past R are invalid');
  assert.strictEqual(gridToAprsLatLon('FN'), null, 'need at least 4 chars');
});

test('6-char grid refines inside the square', () => {
  const p4 = gridToAprsLatLon('FN20');
  const p6 = gridToAprsLatLon('FN20JB');
  assert.notStrictEqual(p6.lat, p4.lat);
  assert.ok(/^\d{4}\.\d{2}N$/.test(p6.lat) && /^\d{5}\.\d{2}W$/.test(p6.lon), 'well-formed DDMM.mm');
});

test('position packet is a valid uncompressed report', () => {
  const pkt = buildPositionPacket('W1AW', 'K3SBP', 'FN20', 'JS8');
  assert.strictEqual(pkt, 'W1AW>APZJS8,TCPIP*,qAR,K3SBP:=4030.00N/07500.00W-JS8');
  assert.strictEqual(buildPositionPacket('W1AW', 'K3SBP', 'garbage'), null);
});

console.log(`\nAPRS-IS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
