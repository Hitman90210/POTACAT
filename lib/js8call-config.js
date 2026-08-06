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
    myGrid: String(v('MyGrid') || '').toUpperCase(),
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

// Severity ranks, worst first.
//
//   blocker  — the bridge cannot function at all (the API is off).
//   conflict — it works, but fights POTACAT for a slice or a DAX channel.
//   notice   — nothing to fix; it changes what POTACAT must EXPECT of the rig.
//   warn     — minor, say it once.
//
// Auto-reply and the heartbeat are `notice`, NOT blockers, and that is a
// deliberate reversal (K3SBP 2026-08-06). Refusing to connect because the
// operator enabled auto-reply would not have prevented a single transmission:
// JS8Call answers heartbeats and directed queries whether or not POTACAT is
// attached. All the refusal achieved was blinding POTACAT to transmissions
// that happen anyway. Connecting is STRICTLY SAFER than not connecting,
// because the API is how we learn JS8Call is keying and yield the radio to it.
// Auto-reply is also how the JS8Call heartbeat network is meant to work — it
// is a feature of the mode, not a misconfiguration.
//
// What it does change: with auto-reply or a heartbeat interval on, JS8Call can
// transmit at ANY time with no warning, so POTACAT must never assume the radio
// is idle just because it isn't using it. That is the radio-owner yield path,
// and reporting it here is what tells the operator (and us) to expect it.
const SEVERITY_ORDER = { blocker: 0, conflict: 1, notice: 2, warn: 3 };

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

  // Unprompted TX. Reported so POTACAT and the operator both expect it —
  // never refused. See the SEVERITY_ORDER note above for why.
  if (s.autoreply) {
    found.push({
      severity: 'notice', code: 'autoreply-on',
      message: `JS8Call will answer heartbeats and directed queries to ${s.myCall || 'you'} on its own, so it can transmit at any time.`,
      fix: 'Nothing to change — POTACAT yields the radio while JS8Call is keyed. Turn off "Auto-reply" in JS8Call if you would rather it stayed silent.',
    });
  }
  if (s.hbInterval > 0) {
    found.push({
      severity: 'notice', code: 'heartbeat-on',
      message: `JS8Call sends its own heartbeat every ${s.hbInterval} minutes, so it can transmit at any time.`,
      fix: 'Nothing to change — POTACAT yields the radio while JS8Call is keyed.',
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

/** Does anything in the diagnosis stop us connecting at all?
 *  Only a dead API does. Nothing about how the operator has chosen to run
 *  their own station is grounds for POTACAT to refuse to look at it. */
function js8ConnectBlocked(problems) {
  return (problems || []).filter((p) => p.severity === 'blocker');
}

/**
 * The heartbeat text this station would transmit.
 *
 * There is no heartbeat command in the API — verified by extracting the
 * command vocabulary from the JS8Call binary itself (TX.SEND_MESSAGE,
 * TX.SET_TEXT, RIG.PTT, STATION.*, RX.*, INBOX.* and nothing else). So a
 * heartbeat is an ordinary message, and rather than invent a format we use the
 * operator's OWN `HBMessage` template from their ini and substitute the same
 * tokens JS8Call does. Whatever JS8Call would send when they press HB is what
 * POTACAT sends.
 *
 * `@HB` is JS8Call's heartbeat group (it sits alongside @ALLCALL, @DX and
 * @GROUP in the binary). A template that already addresses a group is left
 * alone; a bare one is addressed to @HB so it reaches the heartbeat net rather
 * than going out as unaddressed chatter.
 */
function js8HeartbeatText(ini) {
  const s = readJs8Settings(ini);
  const tpl = String(js8Value(ini, 'HBMessage') || 'HB <MYGRID4>').trim();
  const grid4 = (s.myGrid || '').slice(0, 4).toUpperCase();
  let text = tpl
    .replace(/<MYGRID4>/gi, grid4)
    .replace(/<MYGRID>/gi, (s.myGrid || '').toUpperCase())
    .replace(/<MYCALL>/gi, s.myCall || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^@[A-Z]+/i.test(text)) text = `@HB ${text}`;
  return text;
}

/** Can JS8Call key the radio without POTACAT asking it to? True whenever
 *  auto-reply or an outbound heartbeat is on. The radio-owner yield path and
 *  any "is the rig free?" check must assume TX at any moment when this is set. */
function js8MayTransmitUnprompted(ini) {
  const s = readJs8Settings(ini);
  return !!(s.autoreply || s.hbInterval > 0);
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
  js8MayTransmitUnprompted,
  js8HeartbeatText,
};
