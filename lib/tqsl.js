// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// LoTW upload via the operator's own TrustedQSL install (never bundled —
// the cert store and station locations are theirs). Pure helpers here;
// main owns the spawn. Plan + locked decisions: docs/tqsl-lotw-plan.md.
'use strict';

const fs = require('fs');
const path = require('path');

/** Candidate tqsl.exe paths, most likely first. */
function tqslCandidates(platform = process.platform) {
  if (platform === 'win32') {
    return [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'TrustedQSL', 'tqsl.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'TrustedQSL', 'tqsl.exe'),
    ];
  }
  if (platform === 'darwin') return ['/Applications/TrustedQSL/tqsl.app/Contents/MacOS/tqsl', '/Applications/tqsl.app/Contents/MacOS/tqsl'];
  return ['/usr/bin/tqsl', '/usr/local/bin/tqsl'];
}

function findTqsl(configuredPath, platform = process.platform) {
  const all = configuredPath ? [configuredPath, ...tqslCandidates(platform)] : tqslCandidates(platform);
  for (const p of all) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

/** Where TQSL keeps station_data: %APPDATA%\TrustedQSL on Windows,
 *  ~/.tqsl everywhere else (ARRL docs; wxWidgets standard paths). */
function stationDataCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roaming = env.APPDATA || path.join(env.USERPROFILE || 'C:\\', 'AppData', 'Roaming');
    return [path.join(roaming, 'TrustedQSL', 'station_data')];
  }
  const home = env.HOME || '';
  return [path.join(home, '.tqsl', 'station_data')];
}

/** Station Location names from TQSL's station_data XML. Regex, not an XML
 *  parser: the file is TQSL-generated with a fixed shape, and a parser dep
 *  for one attribute is not worth it. */
function parseStationLocations(xml) {
  return [...String(xml || '').matchAll(/<StationData\s+name="([^"]+)"/g)].map((m) => m[1]);
}

/** argv for a batch (headless) sign-and-upload of one ADIF file. */
function buildTqslArgs({ location, adifPath, password }) {
  const args = [
    '-q',              // quiet/batch — no GUI
    '-x',              // exit when done
    '-d',              // suppress the date-range dialog
    '-u',              // sign AND upload to LoTW
    '-a', 'compliant', // duplicates: upload the new ones, skip known dupes
    '-l', String(location || ''),
  ];
  if (password) args.push('-p', String(password));
  args.push(String(adifPath || ''));
  return args;
}

/** TQSL batch exit codes → honest outcomes (TQSL command-line docs). */
function mapTqslExit(code) {
  switch (code) {
    case 0: return { ok: true, message: 'Uploaded to LoTW — all QSOs accepted.' };
    case 8: return { ok: true, message: 'Uploaded to LoTW — new QSOs accepted, previously-uploaded ones skipped as duplicates.' };
    case 9: return { ok: true, message: 'Nothing new to upload — every QSO was already at LoTW (all duplicates).', allDupes: true };
    case 1: return { ok: false, message: 'TQSL was cancelled by the user.' };
    case 2: return { ok: false, message: 'TQSL rejected the station location or callsign certificate — open TQSL and check Station Locations.' };
    case 3: return { ok: false, message: 'TQSL reported a response error talking to LoTW — try again in a minute.' };
    case 4: return { ok: false, message: 'TQSL problem — signing failed. Is the certificate password correct?' };
    case 5: return { ok: false, message: 'TQSL could not open or parse the ADIF file.' };
    case 6: return { ok: false, message: 'TQSL: nothing in the file could be processed.' };
    case 7: return { ok: false, message: 'TQSL: the LoTW server rejected the upload.' };
    case 10: return { ok: false, message: 'TQSL internal error.' };
    case 11: return { ok: false, message: 'TQSL: connection to LoTW failed — check your internet connection.' };
    default: return { ok: false, message: `TQSL exited with unexpected code ${code}.` };
  }
}

module.exports = { tqslCandidates, findTqsl, stationDataCandidates, parseStationLocations, buildTqslArgs, mapTqslExit };
