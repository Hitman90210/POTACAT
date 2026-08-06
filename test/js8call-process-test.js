#!/usr/bin/env node
'use strict';
/**
 * Finding and configuring JS8Call.
 *
 * The patcher is the dangerous part: it edits another application's live config
 * file. JS8Call.ini is Qt QSettings — escaped `@Variant` binary, `@Invalid()`
 * markers, values containing '=', quoted values — and a generic INI library
 * mangles all of it on round-trip. So the contract these tests enforce is
 * narrow and absolute: change the value on the lines we name, append lines we
 * must add, and leave every other byte exactly as it was.
 *
 * Run: node test/js8call-process-test.js
 */

const assert = require('assert');
const {
  js8BinaryNames, js8PathCandidates, js8LaunchArgs,
  desiredJs8Settings, planJs8IniPatch, describeJs8Change, summarizeJs8Changes, shortDevice,
  daxSearchSpecs, smartSdrVersion, pickNewestDax,
} = require('../lib/js8call-process');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// Shaped on the real file, hazards included.
const INI = [
  '[MultiSettings]',
  'CurrentName=Default',
  '',
  '[Configuration]',
  'MyCall=K3SBP',
  'PTTMethod=@Variant(\\0\\0\\0\\x7f\\0\\0\\0\\vPTTMethod\\0\\0\\0\\0\\x2)',
  'DataMode=@Invalid()',
  'FrequenciesForRegionModes_01=AAAD=aGVsbG8=',
  'CQMessage="CQ CQ CQ <MYGRID4>"',
  'CATNetworkPort=127.0.0.1:5002',
  'TCPServerPort=2442',
  'TCPEnabled=false',
  'AcceptTCPRequests=false',
  'TCPMaxConnections=1',
  '',
  '[MainWindow]',
  'geometry=@Variant(\\0\\0\\0\\xff)',
  '',
].join('\n');

// ── discovery ────────────────────────────────────────────────────────────────

test('binary discovery knows the forks, not just the stock name', () => {
  const win = js8BinaryNames('win32');
  assert.ok(win.includes('JS8Call.exe'));
  assert.ok(win.includes('JS8Call-improved.exe'),
    'the build installed in the wild here is the improved fork');
  assert.ok(js8BinaryNames('linux').includes('js8call'));
});

test('an explicit path always wins over discovery', () => {
  const c = js8PathCandidates({ settings: { js8Path: 'D:\\Ham\\my.exe' }, platform: 'win32', env: {} });
  assert.strictEqual(c[0], 'D:\\Ham\\my.exe');
});

test('windows candidates cover the fork directory names', () => {
  const c = js8PathCandidates({ platform: 'win32', env: { 'ProgramFiles': 'C:\\PF' } });
  assert.ok(c.some((p) => /JS8Call-improved[\\/]JS8Call-improved\.exe$/.test(p)), c.slice(0, 6).join('|'));
  assert.ok(c.some((p) => /JS8Call[\\/]JS8Call\.exe$/.test(p)));
});

test('no environment produces no guesses, not a crash', () => {
  assert.deepStrictEqual(js8PathCandidates({ platform: 'win32', env: {} }), []);
});

test('rig-name only appears when one is set', () => {
  assert.deepStrictEqual(js8LaunchArgs({}), []);
  assert.deepStrictEqual(js8LaunchArgs({ js8RigName: 'sliceB' }), ['--rig-name', 'sliceB']);
  assert.deepStrictEqual(js8LaunchArgs({ js8RigName: '   ' }), [], 'blank is not a rig name');
});

// ── what we ask for ──────────────────────────────────────────────────────────

test('the default wants only what the link needs — never the radio', () => {
  const w = desiredJs8Settings({});
  assert.strictEqual(w.TCPEnabled, 'true');
  assert.strictEqual(w.AcceptTCPRequests, 'true');
  assert.ok(!('CATNetworkPort' in w), 'the operator\'s radio setup is not ours to change unasked');
  assert.ok(!('SoundInName' in w));
});

test('max connections is raised, never lowered', () => {
  // JS8Call ships with 1, so connecting would evict JS8Spotter/JS8Net.
  assert.strictEqual(desiredJs8Settings({}).TCPMaxConnections, '4');
  assert.strictEqual(desiredJs8Settings({ maxConnections: 1 }).TCPMaxConnections, '2');
  assert.strictEqual(desiredJs8Settings({ maxConnections: 8 }).TCPMaxConnections, '8');
});

test('radio keys appear only when explicitly requested', () => {
  const w = desiredJs8Settings({ radio: { catPort: 5003, soundIn: 'DAX Audio RX 2', soundOut: 'DAX Audio TX' } });
  assert.strictEqual(w.CATNetworkPort, '127.0.0.1:5003');
  assert.strictEqual(w.PTTport, '127.0.0.1:5003', 'PTT follows CAT or JS8Call keys the wrong slice');
  assert.strictEqual(w.SoundInName, 'DAX Audio RX 2');
});

test('read-only setup omits the command permission', () => {
  assert.ok(!('AcceptTCPRequests' in desiredJs8Settings({ allowTx: false })));
});

// ── the patcher: byte preservation ───────────────────────────────────────────

test('changes only the values named, and reports each one', () => {
  const r = planJs8IniPatch(INI, { TCPEnabled: 'true', AcceptTCPRequests: 'true' });
  assert.deepStrictEqual(r.changes.map((c) => c.key).sort(), ['AcceptTCPRequests', 'TCPEnabled']);
  assert.ok(/^TCPEnabled=true$/m.test(r.text));
  assert.ok(/^AcceptTCPRequests=true$/m.test(r.text));
});

test('every other byte survives — @Variant, @Invalid, quotes, embedded =', () => {
  const r = planJs8IniPatch(INI, { TCPEnabled: 'true' });
  for (const line of [
    'PTTMethod=@Variant(\\0\\0\\0\\x7f\\0\\0\\0\\vPTTMethod\\0\\0\\0\\0\\x2)',
    'DataMode=@Invalid()',
    'FrequenciesForRegionModes_01=AAAD=aGVsbG8=',
    'CQMessage="CQ CQ CQ <MYGRID4>"',
    'geometry=@Variant(\\0\\0\\0\\xff)',
  ]) {
    assert.ok(r.text.includes(line), 'mangled: ' + line);
  }
});

test('a value already correct is not counted as a change', () => {
  const once = planJs8IniPatch(INI, { TCPEnabled: 'true' });
  const twice = planJs8IniPatch(once.text, { TCPEnabled: 'true' });
  assert.strictEqual(twice.changes.length, 0, 'patching is idempotent');
  assert.strictEqual(twice.text, once.text);
});

test('a missing key is appended inside [Configuration], not at the end of file', () => {
  const r = planJs8IniPatch(INI, { HBMessage: 'HB <MYGRID4>' });
  assert.deepStrictEqual(r.changes, [{ key: 'HBMessage', from: '', to: 'HB <MYGRID4>' }]);
  const cfg = r.text.indexOf('[Configuration]');
  const win = r.text.indexOf('[MainWindow]');
  const added = r.text.indexOf('HBMessage=');
  assert.ok(added > cfg && added < win, 'landed in the wrong section');
});

test('only [Configuration] is touched — a same-named key elsewhere is left alone', () => {
  const ini = INI.replace('geometry=@Variant(\\0\\0\\0\\xff)', 'TCPEnabled=false');
  const r = planJs8IniPatch(ini, { TCPEnabled: 'true' });
  var tail = r.text.slice(r.text.indexOf('[MainWindow]'));
  assert.ok(/TCPEnabled=false/.test(tail), 'the MainWindow copy must not be rewritten');
  assert.strictEqual(r.changes.length, 1);
});

test('CRLF files stay CRLF', () => {
  const r = planJs8IniPatch(INI.replace(/\n/g, '\r\n'), { TCPEnabled: 'true' });
  assert.ok(r.text.includes('\r\n'), 'line endings changed');
  assert.ok(!/[^\r]\n/.test(r.text), 'mixed line endings introduced');
});

test('a file with no [Configuration] is reported, not guessed at', () => {
  const r = planJs8IniPatch('[MainWindow]\ngeometry=x\n', { TCPEnabled: 'true' });
  assert.strictEqual(r.missingSection, true);
  assert.deepStrictEqual(r.changes, [], 'nothing invented');
  assert.ok(r.text.includes('geometry=x'));
});

test('empty input is survivable', () => {
  const r = planJs8IniPatch('', { TCPEnabled: 'true' });
  assert.strictEqual(r.missingSection, true);
  assert.deepStrictEqual(r.changes, []);
});

test('the radio move rewrites CAT and PTT together', () => {
  const want = desiredJs8Settings({ radio: { catPort: 5003 } });
  const r = planJs8IniPatch(INI, want);
  assert.ok(/^CATNetworkPort=127\.0\.0\.1:5003$/m.test(r.text));
  assert.ok(/^PTTport=127\.0\.0\.1:5003$/m.test(r.text), 'PTT left on the old slice would key the wrong one');
});

// ── the confirmation the operator reads ──────────────────────────────────────

test('a flag states its outcome and stops — no boolean to parse', () => {
  assert.strictEqual(describeJs8Change({ key: 'TCPEnabled', from: 'false', to: 'true' }),
    'Turn the TCP API on');
  assert.strictEqual(describeJs8Change({ key: 'AcceptTCPRequests', from: 'false', to: 'true' }),
    'Let POTACAT send messages through JS8Call');
});

test('a value that carries information keeps its before and after', () => {
  // The port IS the point here — hiding it would leave the operator unable to
  // check the move against what their radio actually has.
  assert.strictEqual(
    describeJs8Change({ key: 'CATNetworkPort', from: '127.0.0.1:5002', to: '127.0.0.1:5003' }),
    'Move radio control to its own slice: 127.0.0.1:5002 → 127.0.0.1:5003');
  assert.strictEqual(describeJs8Change({ key: 'TCPMaxConnections', from: '1', to: '4' }),
    'Allow more than one program to connect: 1 → 4');
  assert.strictEqual(describeJs8Change({ key: 'HBMessage', from: '', to: 'HB FN20' }),
    'HBMessage → HB FN20');
});

// ── the list the operator reads ──────────────────────────────────────────────

test('the reason nothing works leads, whatever order the ini was in', () => {
  // Shuffled deliberately: planJs8IniPatch emits in file order, which put
  // "Turn the TCP API on" fifth, behind a PTT port.
  const lines = summarizeJs8Changes([
    { key: 'PTTport', from: '127.0.0.1:5002', to: '127.0.0.1:5003' },
    { key: 'SoundInName', from: 'DAX Audio RX 1 (FlexRadio Systems DAX Audio)', to: 'DAX Audio RX 2 (FlexRadio Systems DAX Audio)' },
    { key: 'CATNetworkPort', from: '127.0.0.1:5002', to: '127.0.0.1:5003' },
    { key: 'AcceptTCPRequests', from: 'false', to: 'true' },
    { key: 'TCPEnabled', from: 'false', to: 'true' },
    { key: 'TCPMaxConnections', from: '1', to: '4' },
  ]);
  assert.strictEqual(lines[0], 'Turn the TCP API on');
  assert.strictEqual(lines.length, 4, 'the radio trio is one decision, not three:\n' + lines.join('\n'));
  assert.strictEqual(lines[3],
    'Give it its own slice: radio control and PTT to 127.0.0.1:5003, receive audio to DAX Audio RX 2');
});

test('repointing audio alone is not described as a slice move', () => {
  // The dead-device case: nothing about the radio changes, only a device name
  // that named nothing. Claiming a slice move would describe an action POTACAT
  // is not taking.
  const lines = summarizeJs8Changes([
    { key: 'SoundOutName', from: 'DAX Audio TX (FlexRadio Systems DAX TX)', to: 'DAX RESERVED AUDIO TX (FlexRadio Systems DAX TX)' },
  ]);
  assert.deepStrictEqual(lines,
    ['Point its audio at devices this PC has: transmit audio to DAX RESERVED AUDIO TX']);
});

test('a change we did not anticipate is still shown, never dropped', () => {
  const lines = summarizeJs8Changes([{ key: 'HBMessage', from: '', to: 'HB FN20' }]);
  assert.deepStrictEqual(lines, ['HBMessage → HB FN20']);
});

test('no changes produces no lines', () => {
  assert.deepStrictEqual(summarizeJs8Changes([]), []);
  assert.deepStrictEqual(summarizeJs8Changes(null), []);
});

test('a device drops the driver name it repeats', () => {
  assert.strictEqual(shortDevice('DAX Audio RX 2 (FlexRadio Systems DAX Audio)'), 'DAX Audio RX 2');
  assert.strictEqual(shortDevice('Speakers'), 'Speakers');
  assert.strictEqual(shortDevice(''), '');
});

// ── finding the DAX control panel ────────────────────────────────────────────

test('both SmartSDR install layouts are searched', () => {
  const specs = daxSearchSpecs({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' } });
  // v3.x / v4.0-4.1 nest under FlexRadio Systems with a DAX subfolder…
  assert.ok(specs.some((s) => /FlexRadio Systems$/.test(s.base) && s.sub === 'DAX'));
  // …and v4.2+ installs top-level with DAX.exe beside the app.
  assert.ok(specs.some((s) => s.base === 'C:\\PF' && s.sub === ''));
  assert.deepStrictEqual(daxSearchSpecs({ platform: 'linux', env: {} }), []);
});

test('a version is read out of either layout\'s path', () => {
  assert.deepStrictEqual(smartSdrVersion('C:\\Program Files\\SmartSDR v4.2.20\\DAX.exe'), [4, 2, 20]);
  assert.deepStrictEqual(
    smartSdrVersion('C:\\Program Files\\FlexRadio Systems\\SmartSDR v4.1.5\\DAX\\DAX.exe'), [4, 1, 5]);
  assert.deepStrictEqual(smartSdrVersion('C:\\Nope\\DAX.exe'), []);
});

test('the newest install wins, not the first found', () => {
  // Both paths are real, from the station that hit this. The v4.1.5 tree is an
  // orphan the upgrade left behind: it still holds a DAX.exe, it is missing
  // Newtonsoft.Json.dll, and launching it opens a crash dialog that reads like
  // a FlexRadio bug rather than POTACAT picking the wrong file.
  const orphan = 'C:\\Program Files\\FlexRadio Systems\\SmartSDR v4.1.5\\DAX\\DAX.exe';
  const live = 'C:\\Program Files\\SmartSDR v4.2.20\\DAX.exe';
  assert.strictEqual(pickNewestDax([orphan, live]), live);
  assert.strictEqual(pickNewestDax([live, orphan]), live, 'order found must not matter');
});

test('version compare is numeric per part, not lexical', () => {
  // As text "v4.1.5" sorts above "v4.2.20", and "v4.9" above "v4.10".
  assert.strictEqual(pickNewestDax(['a/SmartSDR v4.1.5/DAX.exe', 'b/SmartSDR v4.2.20/DAX.exe']),
    'b/SmartSDR v4.2.20/DAX.exe');
  assert.strictEqual(pickNewestDax(['a/SmartSDR v4.9.0/DAX.exe', 'b/SmartSDR v4.10.0/DAX.exe']),
    'b/SmartSDR v4.10.0/DAX.exe');
});

test('nothing found is an empty string, not a crash', () => {
  assert.strictEqual(pickNewestDax([]), '');
  assert.strictEqual(pickNewestDax(null), '');
});

console.log(`\nJS8Call process: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
