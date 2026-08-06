#!/usr/bin/env node
'use strict';
/**
 * JS8Call config reader + setup diagnosis.
 *
 * The fixture below is modelled on a REAL JS8Call 2.4.0 ini (K3SBP's, read
 * 2026-08-06) including the parts that break naive INI parsers: a Qt
 * `@Variant(...)` escaped-binary value, an `@Invalid()` marker, a value
 * containing '=' characters, and a quoted value. The reader must survive all
 * of them, because it runs against another application's live config file.
 *
 * Run: node test/js8call-config-test.js
 */

const assert = require('assert');
const {
  parseJs8Ini,
  js8Bool,
  js8ConfigFileName,
  js8ConfigPathCandidates,
  portFromHostPort,
  daxChannelFromDeviceName,
  readJs8Settings,
  diagnoseJs8Config,
  js8ConnectBlocked,
  js8MayTransmitUnprompted,
  js8HeartbeatText,
} = require('../lib/js8call-config');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name); console.log('       ' + e.message); }
}

// A JS8Call fitted out exactly the way a normal single-app station is: API
// off, auto-reply on, sharing POTACAT's slice and DAX channel. i.e. every
// problem at once — which is what a first-time user actually presents with.
const HOSTILE = `[MultiSettings]
CurrentName=Default

[Configuration]
MyCall=K3SBP
MyGrid=FN20JB
PTTMethod=@Variant(\\0\\0\\0\\x7f\\0\\0\\0\\vPTTMethod\\0\\0\\0\\0\\x2)
DataMode=@Invalid()
SoundInName=DAX Audio RX 1 (FlexRadio Systems DAX Audio)
SoundOutName=DAX Audio TX (FlexRadio Systems DAX TX)
AutoreplyOnAtStartup=true
HBInterval=0
CATNetworkPort=127.0.0.1:5002
PTTport=127.0.0.1:5002
TCPServer=127.0.0.1
TCPServerPort=2442
AcceptTCPRequests=false
TCPEnabled=false
TCPMaxConnections=1
CQMessage="CQ CQ CQ <MYGRID4>"
FrequenciesForRegionModes_01=AAAD=aGVsbG8=

[MainWindow]
geometry=@Variant(\\0\\0\\0\\xff)
`;

// The same station, set up correctly for the bridge.
const HEALTHY = HOSTILE
  .replace('AutoreplyOnAtStartup=true', 'AutoreplyOnAtStartup=false')
  .replace('TCPEnabled=false', 'TCPEnabled=true')
  .replace('TCPMaxConnections=1', 'TCPMaxConnections=4')
  .replace('CATNetworkPort=127.0.0.1:5002', 'CATNetworkPort=127.0.0.1:5003')
  .replace('SoundInName=DAX Audio RX 1', 'SoundInName=DAX Audio RX 2');

// ── parser ───────────────────────────────────────────────────────────────────

test('parses sections and plain keys', () => {
  const ini = parseJs8Ini(HOSTILE);
  assert.strictEqual(ini.Configuration.MyCall, 'K3SBP');
  assert.strictEqual(ini.MultiSettings.CurrentName, 'Default');
  assert.ok(ini.MainWindow, 'MainWindow section present');
});

test('carries @Variant and @Invalid values through untouched', () => {
  const ini = parseJs8Ini(HOSTILE);
  assert.ok(ini.Configuration.PTTMethod.startsWith('@Variant('), 'variant kept opaque');
  assert.ok(ini.Configuration.PTTMethod.includes('\\0'), 'backslash escapes not unescaped');
  assert.strictEqual(ini.Configuration.DataMode, '@Invalid()');
});

test('splits on the FIRST = so values containing = survive', () => {
  const ini = parseJs8Ini(HOSTILE);
  assert.strictEqual(ini.Configuration.FrequenciesForRegionModes_01, 'AAAD=aGVsbG8=');
  assert.strictEqual(ini.Configuration.CATNetworkPort, '127.0.0.1:5002');
});

test('strips QSettings quoting but not inner content', () => {
  const ini = parseJs8Ini(HOSTILE);
  assert.strictEqual(ini.Configuration.CQMessage, 'CQ CQ CQ <MYGRID4>');
});

test('tolerates empty, garbage and comment-only input', () => {
  assert.deepStrictEqual(parseJs8Ini(''), {});
  assert.deepStrictEqual(parseJs8Ini('; just a comment\n\n'), {});
  assert.deepStrictEqual(parseJs8Ini('no equals here'), {});
  assert.deepStrictEqual(parseJs8Ini(null), {});
});

test('CRLF line endings parse identically', () => {
  const crlf = parseJs8Ini(HOSTILE.replace(/\n/g, '\r\n'));
  assert.strictEqual(crlf.Configuration.MyCall, 'K3SBP');
  assert.strictEqual(crlf.Configuration.TCPServerPort, '2442');
});

// ── small helpers ────────────────────────────────────────────────────────────

test('js8Bool only accepts the literal QSettings true', () => {
  assert.strictEqual(js8Bool('true'), true);
  assert.strictEqual(js8Bool('TRUE'), true);
  assert.strictEqual(js8Bool('false'), false);
  assert.strictEqual(js8Bool('1'), false, 'QSettings writes true/false, not 1/0');
  assert.strictEqual(js8Bool(undefined), false);
});

test('portFromHostPort and daxChannelFromDeviceName', () => {
  assert.strictEqual(portFromHostPort('127.0.0.1:5003'), 5003);
  assert.strictEqual(portFromHostPort(''), 0);
  assert.strictEqual(portFromHostPort('COM4'), 0);
  assert.strictEqual(daxChannelFromDeviceName('DAX Audio RX 3 (FlexRadio Systems DAX Audio)'), 3);
  assert.strictEqual(daxChannelFromDeviceName('USB Audio CODEC'), 0, 'non-DAX rigs have no channel');
  assert.strictEqual(daxChannelFromDeviceName(''), 0);
});

test('multi-instance ini name follows the --rig-name convention', () => {
  assert.strictEqual(js8ConfigFileName(''), 'JS8Call.ini');
  assert.strictEqual(js8ConfigFileName('sliceB'), 'JS8Call - sliceB.ini');
});

test('config path candidates are platform-correct', () => {
  const win = js8ConfigPathCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\LA' } });
  assert.ok(win.some((p) => /js8call/i.test(p) && /JS8Call\.ini$/.test(p)), win.join('|'));
  const linux = js8ConfigPathCandidates({ platform: 'linux', env: { HOME: '/home/x' } });
  assert.ok(linux.some((p) => p.includes('.config')), linux.join('|'));
  assert.deepStrictEqual(js8ConfigPathCandidates({ platform: 'win32', env: {} }), [],
    'no env means no guesses, not a crash');
});

// ── readJs8Settings ──────────────────────────────────────────────────────────

test('readJs8Settings flattens the facts the bridge needs', () => {
  const s = readJs8Settings(parseJs8Ini(HOSTILE));
  assert.strictEqual(s.myCall, 'K3SBP');
  assert.strictEqual(s.tcpEnabled, false);
  assert.strictEqual(s.tcpPort, 2442);
  assert.strictEqual(s.autoreply, true);
  assert.strictEqual(s.catPort, 5002);
  assert.strictEqual(s.daxRxChannel, 1);
  assert.strictEqual(s.tcpMaxConnections, 1);
});

test('readJs8Settings defaults sanely on an empty ini', () => {
  const s = readJs8Settings({});
  assert.strictEqual(s.tcpPort, 2442, 'documented JS8Call default');
  assert.strictEqual(s.tcpEnabled, false);
  assert.strictEqual(s.myCall, '');
});

// ── diagnosis ────────────────────────────────────────────────────────────────

test('the real-world hostile config reports every problem, worst first', () => {
  const probs = diagnoseJs8Config({
    ini: parseJs8Ini(HOSTILE), potacatSlicePort: 5002, potacatDaxChannel: 1,
  });
  const codes = probs.map((p) => p.code);
  assert.ok(codes.includes('api-disabled'), codes.join(','));
  assert.ok(codes.includes('autoreply-on'), codes.join(','));
  assert.ok(codes.includes('cat-slice-collision'), codes.join(','));
  assert.ok(codes.includes('dax-rx-collision'), codes.join(','));
  assert.ok(codes.includes('single-api-client'), codes.join(','));
  assert.strictEqual(probs[0].code, 'api-disabled', 'blocker sorts ahead of unsafe/conflict/warn');
  assert.ok(probs.every((p) => p.fix && p.message), 'every problem names a fix');
});

test('a correctly set up station reports nothing that blocks', () => {
  const probs = diagnoseJs8Config({
    ini: parseJs8Ini(HEALTHY), potacatSlicePort: 5002, potacatDaxChannel: 1,
  });
  assert.deepStrictEqual(js8ConnectBlocked(probs), [], JSON.stringify(probs));
  assert.deepStrictEqual(probs, [], 'and nothing at all, since collisions are resolved too');
});

// Auto-reply must NEVER block the connection. Refusing would not stop a single
// transmission — JS8Call answers heartbeats whether or not POTACAT is attached
// — it would only blind us to transmissions that happen anyway. Connecting is
// how we see the PTT and yield the radio, so it is strictly safer than not.
// Auto-reply is also how the heartbeat network is meant to work. (K3SBP
// 2026-08-06, reversing the first cut of this rule.)
test('auto-reply is reported but never blocks', () => {
  const ini = parseJs8Ini(HEALTHY.replace('AutoreplyOnAtStartup=false', 'AutoreplyOnAtStartup=true'));
  const probs = diagnoseJs8Config({ ini });
  assert.deepStrictEqual(js8ConnectBlocked(probs), [], 'nothing blocks');
  const n = probs.find((p) => p.code === 'autoreply-on');
  assert.ok(n, 'still reported');
  assert.strictEqual(n.severity, 'notice');
  assert.ok(/transmit at any time/.test(n.message), n.message);
});

test('an outbound heartbeat is reported but never blocks', () => {
  const ini = parseJs8Ini(HEALTHY.replace('HBInterval=0', 'HBInterval=15'));
  const probs = diagnoseJs8Config({ ini });
  assert.deepStrictEqual(js8ConnectBlocked(probs), []);
  const n = probs.find((p) => p.code === 'heartbeat-on');
  assert.strictEqual(n.severity, 'notice');
  assert.ok(/every 15 minutes/.test(n.message), n.message);
});

test('only a dead API blocks the connection', () => {
  const ini = parseJs8Ini(HOSTILE); // API off, autoreply on, both collisions
  const blocked = js8ConnectBlocked(diagnoseJs8Config({
    ini, potacatSlicePort: 5002, potacatDaxChannel: 1,
  }));
  assert.deepStrictEqual(blocked.map((p) => p.code), ['api-disabled'],
    'collisions and unprompted TX are things to know, not reasons to refuse');
});

test('js8MayTransmitUnprompted drives the yield path', () => {
  assert.strictEqual(js8MayTransmitUnprompted(parseJs8Ini(HOSTILE)), true, 'autoreply on');
  assert.strictEqual(js8MayTransmitUnprompted(parseJs8Ini(HEALTHY)), false, 'neither on');
  assert.strictEqual(
    js8MayTransmitUnprompted(parseJs8Ini(HEALTHY.replace('HBInterval=0', 'HBInterval=10'))),
    true, 'heartbeat alone is enough');
});

test('AcceptTCPRequests only matters when we intend to transmit', () => {
  const ini = parseJs8Ini(HEALTHY); // AcceptTCPRequests is false in the fixture
  assert.deepStrictEqual(diagnoseJs8Config({ ini }).map((p) => p.code), [],
    'RX-only does not need command permission');
  assert.deepStrictEqual(diagnoseJs8Config({ ini, needTx: true }).map((p) => p.code),
    ['api-requests-disabled']);
});

test('collision checks are skipped when POTACAT context is unknown', () => {
  // A non-Flex station has no slice port and no DAX channel; inventing a
  // collision from absent data would be worse than saying nothing.
  const probs = diagnoseJs8Config({ ini: parseJs8Ini(HOSTILE) });
  const codes = probs.map((p) => p.code);
  assert.ok(!codes.includes('cat-slice-collision'), codes.join(','));
  assert.ok(!codes.includes('dax-rx-collision'), codes.join(','));
  assert.ok(codes.includes('api-disabled'), 'but real blockers still report');
});

test('a different slice and DAX channel is not a collision', () => {
  const probs = diagnoseJs8Config({
    ini: parseJs8Ini(HEALTHY), potacatSlicePort: 5002, potacatDaxChannel: 1,
  });
  assert.deepStrictEqual(probs.map((p) => p.code), []);
});

test('the slice collision message names the slice letter', () => {
  const probs = diagnoseJs8Config({
    ini: parseJs8Ini(HOSTILE), potacatSlicePort: 5002,
  });
  const c = probs.find((p) => p.code === 'cat-slice-collision');
  assert.ok(/slice A/.test(c.message), c.message);
});

// ── heartbeat composition ────────────────────────────────────────────────────
// There is no heartbeat command in the API — the command vocabulary extracted
// from the JS8Call binary is TX.SEND_MESSAGE / TX.SET_TEXT / RIG.PTT /
// STATION.* / RX.* / INBOX.* and nothing else. So a heartbeat is an ordinary
// message, and rather than invent a format we render the operator's OWN
// HBMessage template. Whatever JS8Call would send when they press HB is what
// POTACAT sends.
// Keys must land INSIDE [Configuration] — appending to the end of the fixture
// puts them in [MainWindow], where js8Value correctly refuses to find them.
function withConfig(base, lines) {
  return base.replace('MyCall=K3SBP', 'MyCall=K3SBP\n' + lines);
}

test('heartbeat renders the station\'s own template', () => {
  const ini = parseJs8Ini(withConfig(HEALTHY, 'HBMessage=HB <MYGRID4>'));
  assert.strictEqual(js8HeartbeatText(ini), '@HB HB FN20');
});

test('heartbeat substitutes every token JS8Call uses', () => {
  const ini = parseJs8Ini(withConfig(HEALTHY, 'HBMessage=<MYCALL> BEACON <MYGRID4> <MYGRID>'));
  assert.strictEqual(js8HeartbeatText(ini), '@HB K3SBP BEACON FN20 FN20JB');
});

test('a template already addressed to a group is left alone', () => {
  // @ALLCALL, @DX and @GROUP live alongside @HB in the binary; an operator who
  // has aimed their heartbeat somewhere specific must not be silently
  // re-addressed to @HB.
  const ini = parseJs8Ini(withConfig(HEALTHY, 'HBMessage=@ALLCALL HELLO <MYGRID4>'));
  assert.strictEqual(js8HeartbeatText(ini), '@ALLCALL HELLO FN20');
});

test('a missing HBMessage falls back to the JS8Call default', () => {
  assert.strictEqual(js8HeartbeatText(parseJs8Ini(HEALTHY)), '@HB HB FN20');
});

test('heartbeat collapses whitespace so an empty token leaves no gap', () => {
  const noGrid = HEALTHY.replace('MyGrid=FN20JB\n', '');
  const ini = parseJs8Ini(withConfig(noGrid, 'HBMessage=HB   <MYGRID4>   '));
  assert.strictEqual(js8HeartbeatText(ini), '@HB HB', 'no trailing or doubled spaces');
});

console.log(`\nJS8Call config: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
