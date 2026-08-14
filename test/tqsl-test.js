#!/usr/bin/env node
'use strict';
// LoTW/TQSL helpers — the argv and exit-code mapping ARE the integration
// contract with the operator's TQSL install. Run: node test/tqsl-test.js
const assert = require('assert');
const { parseStationLocations, buildTqslArgs, mapTqslExit, tqslCandidates, stationDataCandidates } = require('../lib/tqsl');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('station locations parse from TQSL station_data', () => {
  const xml = `<StationDataFile>\n  <StationData name="K3SBP Shack">\n<CALL>K3SBP</CALL>\n</StationData>\n  <StationData name="Portable">\n</StationData>\n</StationDataFile>`;
  assert.deepStrictEqual(parseStationLocations(xml), ['K3SBP Shack', 'Portable']);
  assert.deepStrictEqual(parseStationLocations(''), []);
});

test('argv: batch, upload, compliant-dupes, location, optional password LAST before file', () => {
  assert.deepStrictEqual(
    buildTqslArgs({ location: 'K3SBP Shack', adifPath: 'C:\\t\\up.adi' }),
    ['-q', '-x', '-d', '-u', '-a', 'compliant', '-l', 'K3SBP Shack', 'C:\\t\\up.adi']);
  const withPw = buildTqslArgs({ location: 'L', adifPath: 'f.adi', password: 'pw' });
  assert.ok(withPw.includes('-p') && withPw[withPw.length - 1] === 'f.adi');
});

test('exit codes: 0/8/9 are success variants, the rest name their cause', () => {
  assert.strictEqual(mapTqslExit(0).ok, true);
  assert.strictEqual(mapTqslExit(8).ok, true);
  assert.strictEqual(mapTqslExit(9).ok, true);
  // 8 = "No QSOs to upload" — proven by a live full-dupe re-run 2026-08-13.
  assert.strictEqual(mapTqslExit(8).allDupes, true);
  for (const c of [1, 2, 3, 4, 5, 6, 7, 10, 11, 42]) {
    const r = mapTqslExit(c);
    assert.strictEqual(r.ok, false, 'code ' + c);
    assert.ok(r.message.length > 10, 'code ' + c + ' names its cause');
  }
});

test('station_data lives in Roaming on win32, ~/.tqsl elsewhere', () => {
  const win = stationDataCandidates('win32', { APPDATA: 'C:\\Users\\op\\AppData\\Roaming' });
  assert.ok(/Roaming[\\/]TrustedQSL[\\/]station_data$/.test(win[0]));
  const nix = stationDataCandidates('darwin', { HOME: '/Users/op' });
  assert.ok(/\.tqsl[\\/]station_data$/.test(nix[0]));
});

test('windows candidates hit both Program Files', () => {
  const c = tqslCandidates('win32');
  assert.ok(c.some((p) => /Program Files \(x86\).*tqsl\.exe$/.test(p)));
  assert.ok(c.length >= 2);
});

console.log(`\nTQSL: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
