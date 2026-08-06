// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Finding JS8Call, and setting it up to talk to POTACAT.
//
// Pure: path/arg/text decisions only, no spawning and no file I/O, so all of it
// is testable without a radio or an install. main.js does the actual work.
//
// THE INI RULE. js8call-config.js reads JS8Call.ini and deliberately never
// writes it, because it is a Qt QSettings file full of escaped `@Variant`
// binary and `@Invalid()` markers that a generic INI library destroys on
// round-trip. This module writes it anyway — but only ever by substituting the
// value on a single already-existing line, or appending one line to a section.
// Every other byte of the file is passed through untouched. That is the only
// way to change another application's config without becoming responsible for
// re-serialising a format we do not fully understand.
//
// The other half of the rule lives in main.js: never patch while JS8Call is
// running. Qt writes the whole file back out on exit, so anything we changed
// underneath it would be silently reverted.

'use strict';

const path = require('path');

/** Windows installs vary by fork. The build seen in the wild here is
 *  "JS8Call-improved", whose executable is NOT js8call.exe — assuming the
 *  stock name is why discovery would find nothing on a working install. */
const WIN_EXES = ['JS8Call.exe', 'js8call.exe', 'JS8Call-improved.exe'];
const NIX_EXES = ['js8call', 'JS8Call', 'js8call-improved'];

function js8BinaryNames(platform = process.platform) {
  return platform === 'win32' ? WIN_EXES.slice() : NIX_EXES.slice();
}

/**
 * Where the JS8Call executable might be, best guess first.
 * An explicit `settings.js8Path` always wins — discovery is a convenience, not
 * a constraint on where someone may install things.
 */
function js8PathCandidates({ settings = {}, platform = process.platform, env = process.env } = {}) {
  const out = [];
  if (settings.js8Path) out.push(settings.js8Path);
  const names = js8BinaryNames(platform);

  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter(Boolean);
    // Fork directory names mirror the executable names.
    const dirs = ['JS8Call', 'JS8Call-improved', 'js8call'];
    for (const r of roots) for (const d of dirs) for (const n of names) out.push(path.join(r, d, n));
  } else if (platform === 'darwin') {
    out.push('/Applications/js8call.app/Contents/MacOS/js8call');
    out.push('/Applications/JS8Call.app/Contents/MacOS/js8call');
    if (env.HOME) out.push(path.join(env.HOME, 'Applications', 'js8call.app', 'Contents', 'MacOS', 'js8call'));
  } else {
    for (const d of ['/usr/bin', '/usr/local/bin', '/opt/js8call/bin', '/snap/bin']) {
      for (const n of names) out.push(path.join(d, n));
    }
  }
  return out;
}

/** Launch args. `--rig-name` gives a second instance its own config and data
 *  (confirmed present on 2.4.0), which is what a second radio or slice needs. */
function js8LaunchArgs(settings = {}) {
  const rig = String(settings.js8RigName || '').trim();
  return rig ? ['--rig-name', rig] : [];
}

/**
 * What POTACAT wants JS8Call's config to say.
 *
 * Only the keys that make the link work are included by default. The radio and
 * audio keys are separate and opt-in (`includeRadio`), because those are the
 * operator's own station setup — moving their CAT port or sound card without
 * being asked would be POTACAT reconfiguring their radio behind their back.
 *
 * @param {object} o
 * @param {number} [o.tcpPort]        API port to settle on
 * @param {number} [o.maxConnections] keep room for JS8Spotter/JS8Net alongside us
 * @param {boolean} [o.allowTx]       also permit API commands (needed to send)
 * @param {object} [o.radio]          {catPort, soundIn, soundOut} — Flex slice move
 */
function desiredJs8Settings({ tcpPort = 2442, maxConnections = 4, allowTx = true, radio = null } = {}) {
  const want = {
    TCPEnabled: 'true',
    TCPServer: '127.0.0.1',
    TCPServerPort: String(tcpPort),
    // Raise, never lower: JS8Call allows ONE API client by default, so leaving
    // it at 1 means connecting evicts whatever else the operator uses.
    TCPMaxConnections: String(Math.max(2, maxConnections)),
  };
  if (allowTx) want.AcceptTCPRequests = 'true';
  if (radio) {
    if (radio.catPort) {
      want.CATNetworkPort = `127.0.0.1:${radio.catPort}`;
      want.PTTport = `127.0.0.1:${radio.catPort}`;
    }
    if (radio.soundIn) want.SoundInName = radio.soundIn;
    if (radio.soundOut) want.SoundOutName = radio.soundOut;
  }
  return want;
}

/**
 * Produce the patched ini text, byte-preserving.
 *
 * Substitutes the value on an existing `Key=…` line inside [Configuration], or
 * appends `Key=value` at the end of that section when the key is absent.
 * Nothing else in the file is touched — not the @Variant blobs, not the
 * quoting, not the key order, not the line endings.
 *
 * @returns {{text:string, changes:Array<{key:string,from:string,to:string}>, missingSection:boolean}}
 */
function planJs8IniPatch(text, want) {
  const src = String(text == null ? '' : text);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const changes = [];
  const remaining = Object.assign({}, want);

  let inConfig = false;
  let configStart = -1, configEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sec = line.trim().match(/^\[(.+)\]$/);
    if (sec) {
      if (inConfig) { configEnd = i; inConfig = false; }
      if (sec[1] === 'Configuration') { inConfig = true; configStart = i; }
      continue;
    }
    if (!inConfig) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!Object.prototype.hasOwnProperty.call(remaining, key)) continue;
    const from = line.slice(eq + 1);
    const to = remaining[key];
    if (from !== to) {
      lines[i] = key + '=' + to;
      changes.push({ key, from, to });
    }
    delete remaining[key];
  }
  if (inConfig) configEnd = lines.length;
  if (configEnd < 0 && configStart >= 0) configEnd = lines.length;

  const missingSection = configStart < 0;
  const toAdd = Object.keys(remaining);
  if (toAdd.length && !missingSection) {
    // Append inside [Configuration], after its last non-blank line, so the file
    // keeps its shape.
    let at = configEnd;
    while (at > configStart + 1 && lines[at - 1].trim() === '') at--;
    const added = toAdd.map((k) => {
      changes.push({ key: k, from: '', to: remaining[k] });
      return k + '=' + remaining[k];
    });
    lines.splice(at, 0, ...added);
  }

  return { text: lines.join(eol), changes, missingSection };
}

/**
 * A short, human sentence per change, for the confirmation the operator sees
 * before anything is written.
 *
 * Flag-shaped settings state the OUTCOME and stop — "Turn the TCP API on:
 * false → true" makes the reader parse a boolean to learn what the sentence
 * already told them. Values that carry information (ports, device names, a
 * connection count) keep their before-and-after, because the number is the
 * point.
 */
const CHANGE_LABELS = {
  TCPEnabled: 'Turn the TCP API on',
  AcceptTCPRequests: 'Let POTACAT send messages through JS8Call',
  TCPServerPort: 'API port',
  TCPServer: 'API address',
  TCPMaxConnections: 'Allow more than one program to connect',
  CATNetworkPort: 'Move radio control to its own slice',
  PTTport: 'Move PTT to the same slice',
  SoundInName: 'Receive audio',
  SoundOutName: 'Transmit audio',
};
/** Booleans whose label already says which way they end up. */
const FLAG_KEYS = new Set(['TCPEnabled', 'AcceptTCPRequests']);

function describeJs8Change(c) {
  const label = CHANGE_LABELS[c.key] || c.key;
  if (FLAG_KEYS.has(c.key)) return label;
  if (!c.from) return `${label} → ${c.to}`;
  return `${label}: ${c.from} → ${c.to}`;
}

/** "DAX Audio RX 2 (FlexRadio Systems DAX Audio)" → "DAX Audio RX 2". The
 *  driver's own name for itself is not information the operator needs twice. */
function shortDevice(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * The change list as the operator should READ it, rather than as the ini
 * happens to be ordered.
 *
 * Two things this fixes. Order: an ini-ordered list buried "Turn the TCP API
 * on" — the reason nothing works at all — at position five, behind a PTT port.
 * Grouping: CATNetworkPort, PTTport and SoundInName are not three decisions,
 * they are one (the slice checkbox), and listing them separately invites the
 * reader to weigh them separately when they cannot be.
 *
 * @param {Array<{key:string,from:string,to:string}>} changes
 * @returns {string[]} display lines, most consequential first
 */
function summarizeJs8Changes(changes) {
  const by = new Map((changes || []).map((c) => [c.key, c]));
  const out = [];
  const take = (k) => { const c = by.get(k); if (c) { by.delete(k); out.push(describeJs8Change(c)); } };

  take('TCPEnabled');
  take('AcceptTCPRequests');
  take('TCPServer');
  take('TCPServerPort');
  take('TCPMaxConnections');

  const cat = by.get('CATNetworkPort') || by.get('PTTport');
  const sIn = by.get('SoundInName');
  const sOut = by.get('SoundOutName');
  if (cat || sIn || sOut) {
    const bits = [];
    if (cat) bits.push('radio control and PTT to ' + cat.to);
    if (sIn) bits.push('receive audio to ' + shortDevice(sIn.to));
    if (sOut) bits.push('transmit audio to ' + shortDevice(sOut.to));
    // Audio alone is not a slice move. Saying "give it its own slice" when the
    // only change is repointing a device at one that exists would describe an
    // action POTACAT is not taking.
    out.push((cat ? 'Give it its own slice: ' : 'Point its audio at devices this PC has: ')
      + bits.join(', '));
    for (const k of ['CATNetworkPort', 'PTTport', 'SoundInName', 'SoundOutName']) by.delete(k);
  }

  // Anything we did not anticipate still gets shown — silently dropping a
  // change we are about to write to someone's file is the one unforgivable bug.
  for (const c of by.values()) out.push(describeJs8Change(c));
  return out;
}

module.exports = {
  js8BinaryNames,
  js8PathCandidates,
  js8LaunchArgs,
  desiredJs8Settings,
  planJs8IniPatch,
  describeJs8Change,
  summarizeJs8Changes,
  shortDevice,
};
