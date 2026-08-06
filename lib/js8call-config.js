/**
 * JS8Call configuration reader — READ ONLY.
 *
 * POTACAT bridges JS8Call over its TCP API rather than decoding JS8 itself:
 * JS8Call is GPLv3, and a separate process spoken to over a socket is mere
 * aggregation, while linking or porting its code would relicense POTACAT
 * (same posture as wsprd and Mercury — see lib/wspr-decoder.js and
 * third_party/wsprd/README.md).
 *
 * That bridge only works if JS8Call is configured for it, and out of the box
 * it is NOT: `TCPEnabled` and `AcceptTCPRequests` both default to false. Worse,
 * a JS8Call set up for a normal single-app station actively fights POTACAT for
 * the same radio resources. So before connecting we read its ini and say
 * exactly what's wrong, in the operator's terms — the lesson of the Mercury
 * modem, which sat dead for weeks because nothing reported why.
 *
 * WHY THIS FILE NEVER WRITES: JS8Call.ini is a Qt QSettings file. It contains
 * escaped binary blobs (`@Variant(\0\0\0\x7f...)`), `@Invalid()` markers, and
 * values whose quoting and backslash escaping a generic INI library will
 * silently mangle. Qt also rewrites the whole file on exit, so anything we
 * wrote while JS8Call was running would be reverted anyway. We read, we
 * explain, the operator clicks the checkbox.
 */

'use strict';

const path = require('path');

/** Section holding everything the bridge cares about. */
const CONFIG_SECTION = 'Configuration';

/**
 * Parse a Qt QSettings ini into { section: { key: rawValue } }.
 *
 * Deliberately dumb and lossless-enough-for-reading: values are returned as
 * the raw text after the first `=`, with QSettings' surrounding quotes removed
 * but no unescaping. Nothing here is ever written back, so a value we don't
 * fully understand (a @Variant blob) is simply carried as opaque text instead
 * of being a parse failure.
 */
function parseJs8Ini(text) {
  const out = {};
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1]; if (!out[section]) out[section] = {}; continue; }
    // Split on the FIRST '=' only — values legitimately contain '=' (base64 in
    // @Variant blobs, host:port pairs, escaped HTML in RXActivity).
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!out[section]) out[section] = {};
    out[section][key] = val;
  }
  return out;
}

/** Read a key from the Configuration section (the only one we use). */
function js8Value(ini, key, section = CONFIG_SECTION) {
  const s = ini && ini[section];
  return (s && Object.prototype.hasOwnProperty.call(s, key)) ? s[key] : undefined;
}

/** QSettings writes booleans as literal true/false. Anything else is absent. */
function js8Bool(v) {
  return String(v).trim().toLowerCase() === 'true';
}

function js8Int(v, fallback = 0) {
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Where JS8Call keeps its ini. `rigName` selects a multi-instance profile:
 * JS8Call follows the WSJT-X convention of `JS8Call - <rig name>.ini` beside
 * the default one (`--rig-name` is confirmed present on 2.4.0).
 */
function js8ConfigFileName(rigName = '') {
  const n = String(rigName || '').trim();
  return n ? `JS8Call - ${n}.ini` : 'JS8Call.ini';
}

function js8ConfigPathCandidates({ platform = process.platform, env = process.env, rigName = '' } = {}) {
  const file = js8ConfigFileName(rigName);
  const out = [];
  if (platform === 'win32') {
    // Observed on a real install: %LOCALAPPDATA%\js8call\JS8Call.ini (lowercase
    // dir). Case-insensitive filesystem, but list both so a case-sensitive
    // mount or a future port still resolves.
    if (env.LOCALAPPDATA) {
      out.push(path.join(env.LOCALAPPDATA, 'js8call', file));
      out.push(path.join(env.LOCALAPPDATA, 'JS8Call', file));
    }
  } else if (platform === 'darwin') {
    if (env.HOME) out.push(path.join(env.HOME, 'Library', 'Preferences', 'JS8Call', file));
  } else {
    if (env.HOME) {
      out.push(path.join(env.HOME, '.config', 'JS8Call', file));
      out.push(path.join(env.HOME, '.local', 'share', 'JS8Call', file));
    }
  }
  return out;
}

/** `127.0.0.1:5002` → 5002. Returns 0 when absent or unparseable. */
function portFromHostPort(v) {
  const m = String(v || '').match(/:(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** `DAX Audio RX 3 (FlexRadio Systems DAX Audio)` → 3. 0 when not a DAX device. */
function daxChannelFromDeviceName(name) {
  const m = String(name || '').match(/DAX\s+Audio\s+RX\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Flatten the ini into the handful of facts the bridge reasons about, so
 * callers never poke at raw keys.
 */
function readJs8Settings(ini) {
  const v = (k) => js8Value(ini, k);
  return {
    myCall: String(v('MyCall') || '').toUpperCase(),
    tcpEnabled: js8Bool(v('TCPEnabled')),
    acceptTcpRequests: js8Bool(v('AcceptTCPRequests')),
    tcpPort: js8Int(v('TCPServerPort'), 2442),
    tcpHost: String(v('TCPServer') || '127.0.0.1'),
    tcpMaxConnections: js8Int(v('TCPMaxConnections'), 1),
    autoreply: js8Bool(v('AutoreplyOnAtStartup')),
    hbInterval: js8Int(v('HBInterval'), 0),
    catPort: portFromHostPort(v('CATNetworkPort')),
    pttPort: portFromHostPort(v('PTTport')),
    soundIn: String(v('SoundInName') || ''),
    soundOut: String(v('SoundOutName') || ''),
    daxRxChannel: daxChannelFromDeviceName(v('SoundInName')),
  };
}

// Severity ranks. 'blocker' = the bridge cannot function; 'unsafe' = it would
// function but the radio may transmit without an operator, which we refuse;
// 'conflict' = it works but fights POTACAT for a resource; 'warn' = worth
// saying once. Sorted in this order so the first entry is always the thing to
// fix first.
const SEVERITY_ORDER = { blocker: 0, unsafe: 1, conflict: 2, warn: 3 };

/**
 * Everything wrong with this JS8Call setup, worst first.
 *
 * @param {object} o
 * @param {object} o.ini                 parseJs8Ini() output
 * @param {number} [o.potacatSlicePort]  the Flex CAT shim port POTACAT drives (5002-5005)
 * @param {number} [o.potacatDaxChannel] the DAX RX channel POTACAT captures on
 * @param {boolean} [o.needTx]           reserved: TX is a later phase, RX-only today
 * @returns {Array<{severity:string, code:string, message:string, fix:string}>}
 */
function diagnoseJs8Config({ ini, potacatSlicePort = 0, potacatDaxChannel = 0, needTx = false } = {}) {
  const s = readJs8Settings(ini);
  const found = [];

  if (!s.tcpEnabled) {
    found.push({
      severity: 'blocker', code: 'api-disabled',
      message: 'JS8Call\'s TCP API is turned off, so POTACAT cannot read anything from it.',
      fix: 'In JS8Call: File > Settings > Reporting > API, tick "Enable TCP Server API", then restart JS8Call.',
    });
  }
  if (needTx && !s.acceptTcpRequests) {
    found.push({
      severity: 'blocker', code: 'api-requests-disabled',
      message: 'JS8Call accepts no API commands, so POTACAT cannot send messages through it.',
      fix: 'In JS8Call: File > Settings > Reporting > API, tick "Accept TCP Requests".',
    });
  }

  // Safety. An unattended auto-reply turns a "monitor" into a transmitter the
  // operator never authorised for this session — refuse rather than warn.
  if (s.autoreply) {
    found.push({
      severity: 'unsafe', code: 'autoreply-on',
      message: `JS8Call will answer directed calls to ${s.myCall || 'you'} automatically, with nobody at the radio.`,
      fix: 'In JS8Call: File > Settings > General, untick "Auto-reply on at startup". POTACAT will not connect while this is on.',
    });
  }
  if (s.hbInterval > 0) {
    found.push({
      severity: 'unsafe', code: 'heartbeat-on',
      message: `JS8Call is set to transmit a heartbeat every ${s.hbInterval} minutes, unattended.`,
      fix: 'Set the heartbeat interval to off in JS8Call before using it as a monitor.',
    });
  }

  // Resource collisions with POTACAT. Only meaningful when we know what
  // POTACAT itself is using, so each is skipped when its input is absent.
  if (potacatSlicePort && s.catPort && s.catPort === potacatSlicePort) {
    const letter = String.fromCharCode(65 + (s.catPort - 5002));
    found.push({
      severity: 'conflict', code: 'cat-slice-collision',
      message: `JS8Call drives the same slice as POTACAT (slice ${letter}, CAT port ${s.catPort}). They will fight over frequency and mode.`,
      fix: `Give JS8Call its own slice: File > Settings > Radio > CAT network port, use a different port in 5002-5005 (POTACAT is on ${potacatSlicePort}).`,
    });
  }
  if (potacatDaxChannel && s.daxRxChannel && s.daxRxChannel === potacatDaxChannel) {
    found.push({
      severity: 'conflict', code: 'dax-rx-collision',
      message: `JS8Call captures DAX Audio RX ${s.daxRxChannel}, the same channel POTACAT uses.`,
      fix: `Point JS8Call at a different DAX RX channel — one bound to its own slice — in File > Settings > Audio.`,
    });
  }

  if (s.tcpMaxConnections < 2) {
    found.push({
      severity: 'warn', code: 'single-api-client',
      message: 'JS8Call allows only one API client at a time, so POTACAT and another tool (JS8Spotter, JS8Net) cannot both connect.',
      fix: 'Raise "Max connections" under Reporting > API if you use other JS8Call tools.',
    });
  }

  found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return found;
}

/** Does anything in the diagnosis stop us connecting at all? */
function js8ConnectBlocked(problems) {
  return (problems || []).filter((p) => p.severity === 'blocker' || p.severity === 'unsafe');
}

module.exports = {
  CONFIG_SECTION,
  parseJs8Ini,
  js8Value,
  js8Bool,
  js8Int,
  js8ConfigFileName,
  js8ConfigPathCandidates,
  portFromHostPort,
  daxChannelFromDeviceName,
  readJs8Settings,
  diagnoseJs8Config,
  js8ConnectBlocked,
};
