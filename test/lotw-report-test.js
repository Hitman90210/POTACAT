#!/usr/bin/env node
'use strict';
// LoTW confirmation download — URL, report parsing, matcher/stamper.
// Run: node test/lotw-report-test.js
const assert = require('assert');
const { buildLotwReportQuery, parseLotwAdif, looksLikeLotwAuthFailure, stampLotwConfirmations } = require('../lib/lotw-report');
const { lotwKey } = require('../lib/lotw-flags');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const REPORT = `ARRL Logbook of the World Status Report
Generated at 2026-08-15
<PROGRAMID:4>LoTW
<APP_LoTW_LASTQSL:19>2026-08-15 01:02:03
<eoh>

<CALL:4>N2BJ
<BAND:3>20M
<MODE:3>FT8
<QSO_DATE:8>20260814
<TIME_ON:6>152000
<QSL_RCVD:1>Y
<QSLRDATE:8>20260815
<DXCC:3>291
<eor>

<CALL:4>KP2B
<BAND:3>40M
<MODE:2>CW
<QSO_DATE:8>20260221
<TIME_ON:6>030600
<QSL_RCVD:1>Y
<QSLRDATE:8>20260814
<eor>
`;

test('query: creds + qsl flags + incremental since', () => {
  const q = buildLotwReportQuery({ login: 'K3SBP', password: 'p w', qslSince: '2026-08-01' });
  assert.strictEqual(q.host, 'lotw.arrl.org');
  assert.ok(q.path.startsWith('/lotwuser/lotwreport.adi?'));
  assert.ok(q.path.includes('login=K3SBP') && q.path.includes('password=p+w'));
  assert.ok(q.path.includes('qso_qsl=yes') && q.path.includes('qso_qslsince=2026-08-01'));
  assert.ok(!buildLotwReportQuery({ login: 'a', password: 'b' }).path.includes('qslsince'));
});

test('parse: preamble skipped, two records, fields upcased', () => {
  const recs = parseLotwAdif(REPORT);
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].CALL, 'N2BJ');
  assert.strictEqual(recs[0].QSLRDATE, '20260815');
  assert.strictEqual(recs[1].BAND, '40M');
});

test('auth-failure page detected; real report is not', () => {
  assert.strictEqual(looksLikeLotwAuthFailure('<!DOCTYPE html><html><body>Username/password not valid</body></html>'), true);
  assert.strictEqual(looksLikeLotwAuthFailure(REPORT), false);
});

test('stamp: confirms with band cross-check, backfills sent, counts already/unmatched', () => {
  const qsos = [
    { CALL: 'N2BJ', BAND: '20m', QSO_DATE: '20260814', TIME_ON: '152000', LOTW_QSL_SENT: 'Y' },
    { CALL: 'KP2B', BAND: '80m', QSO_DATE: '20260221', TIME_ON: '030600' }, // band mismatch vs 40M
  ];
  const res = stampLotwConfirmations(qsos, parseLotwAdif(REPORT), lotwKey);
  assert.strictEqual(res.confirmed, 1);
  assert.strictEqual(qsos[0].LOTW_QSL_RCVD, 'Y');
  assert.strictEqual(qsos[0].LOTW_QSLRDATE, '20260815');
  assert.strictEqual(qsos[1].LOTW_QSL_RCVD, undefined);
  assert.strictEqual(res.unmatched.length, 1);
  // second run: nothing new
  const res2 = stampLotwConfirmations(qsos, parseLotwAdif(REPORT), lotwKey);
  assert.strictEqual(res2.confirmed, 0);
  assert.strictEqual(res2.alreadyConfirmed, 1);
});

console.log(`\nLoTW report: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
