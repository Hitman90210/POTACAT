// SPDX-License-Identifier: GPL-3.0-or-later
// Derived from JS8Call's Varicode.cpp, JSC.cpp and DecodedText.cpp
// (C) 2018-2026 Jordan Sherer <kn4crd@gmail.com> and the JS8Call-improved
// contributors, GPLv3. JavaScript port (C) 2026 Casey Stanton, GPLv3.
//
// The JS8 MESSAGE codec: 12-character modem frames <-> human messages.
// The modem itself (audio <-> frames) is lib/js8_native; this layer is
// everything above it — heartbeat/compound/directed/data frame packing,
// the Huffman and JSC dense-text codings, callsign/grid/command packing,
// and frame interpretation (the DecodedText logic).
//
// WHY JAVASCRIPT: upstream leans on QRegularExpression (PCRE, named groups)
// and QString (UTF-16) — both of which map far more faithfully onto
// JavaScript's native regex/strings than onto std::regex/std::string. The
// port keeps upstream's names and structure so the two can be diffed
// function by function. Bit vectors are arrays of 0/1; anything that can
// exceed 2^53 goes through BigInt.
//
// Dual-mode: require() from main/worker, window.Js8Varicode via <script>.

'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Js8Varicode = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── constants ─────────────────────────────────────────────────────────────

  const NALPHABET = 41;
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
  const ALPHABET72 =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?.';
  const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@';

  const GRID_PATTERN =
    '(?<grid>[A-X]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)*)+';
  const BASE_CALLSIGN_PATTERN =
    '(?<callsign>\\b(?<base>([0-9A-Z])?([0-9A-Z])([0-9])([A-Z])?([A-Z])?([A-Z])?)(?<portable>[/][P])?\\b)';
  const COMPOUND_CALLSIGN_PATTERN =
    '(?<callsign>(?:[@]?|\\b)(?<extended>[A-Z0-9/@][A-Z0-9/]{0,2}[/]?[A-Z0-9/]{0,3}[/]?[A-Z0-9/]{0,3})\\b)';
  const PACK_CALLSIGN_PATTERN =
    '([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])';

  // Frame types (Varicode.h)
  const FrameType = {
    FrameUnknown: 255,
    FrameHeartbeat: 0,
    FrameCompound: 1,
    FrameCompoundDirected: 2,
    FrameDirected: 3,
    FrameData: 4,
    FrameDataCompressed: 6,
  };

  // Transmission types (the per-frame itype bits)
  const TransmissionType = {
    JS8Call: 0,      // any other frame of the message
    JS8CallFirst: 1, // first frame
    JS8CallLast: 2,  // last frame
    JS8CallData: 4,  // flagged (fast) data frame
  };

  const SubmodeType = {
    JS8CallNormal: 0, JS8CallFast: 1, JS8CallTurbo: 2,
    JS8CallSlow: 4, JS8CallUltra: 8,
  };

  // Directed commands. Insertion order irrelevant — every lookup that
  // depends on QMap's key-sorted iteration goes through cmdKeysSorted.
  const DIRECTED_CMDS = new Map([
    [' HEARTBEAT', -1], [' HB', -1], [' CQ', -1],
    [' SNR?', 0], ['?', 0],
    [' DIT DIT', 1],
    [' HEARING?', 3],
    [' GRID?', 4],
    ['>', 5],
    [' STATUS?', 6],
    [' STATUS', 7],
    [' HEARING', 8],
    [' MSG', 9],
    [' MSG TO:', 10],
    [' QUERY', 11],
    [' QUERY MSGS', 12], [' QUERY MSGS?', 12],
    [' QUERY CALL', 13],
    [' GRID', 15],
    [' INFO?', 16], [' INFO', 17],
    [' FB', 18], [' HW CPY?', 19], [' SK', 20], [' RR', 21],
    [' QSL?', 22], [' QSL', 23],
    [' CMD', 24],
    [' SNR', 25], [' NO', 26], [' YES', 27], [' 73', 28],
    [' NACK', 2], [' ACK', 14],
    [' HEARTBEAT SNR', 29],
    [' AGN?', 30],
    ['  ', 31], [' ', 31],
  ]);
  const ALLOWED_CMDS = new Set([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
  const AUTOREPLY_CMDS = new Set([0, 2, 3, 4, 6, 9, 10, 11, 12, 13, 14, 16, 30]);
  const BUFFERED_CMDS = new Set([5, 9, 10, 11, 12, 13, 15, 24]);
  const SNR_CMDS = new Set([25, 29]);
  const CHECKSUM_CMDS = new Map([[5, 16], [9, 16], [10, 16], [11, 16],
    [12, 16], [13, 16], [15, 0], [24, 16]]);

  // QMap::key(value) returns the first key in ASCENDING key order whose
  // value matches. Precompute that order once.
  const CMD_KEYS_SORTED = Array.from(DIRECTED_CMDS.keys()).sort();
  function cmdKeyForValue(value) {
    for (const k of CMD_KEYS_SORTED) {
      if (DIRECTED_CMDS.get(k) === value) return k;
    }
    return '';
  }

  const CALLSIGN_PATTERN = '(?<callsign>[@]?[A-Z0-9/]+)';
  const OPTIONAL_CMD_PATTERN =
    '(?<cmd>\\s?(?:AGN[?]|QSL[?]|HW CPY[?]|MSG TO[:]|SNR[?]|INFO[?]|GRID[?]|STATUS[?]|QUERY MSGS[?]|HEARING[?]|(?:(?:STATUS|HEARING|QUERY CALL|QUERY MSGS|QUERY|CMD|MSG|NACK|ACK|73|YES|NO|HEARTBEAT SNR|SNR|QSL|RR|SK|FB|INFO|GRID|DIT DIT)(?=[ ]|$))|[?> ]))?';
  const OPTIONAL_GRID_PATTERN = '(?<grid>\\s?[A-R]{2}[0-9]{2})?';
  const OPTIONAL_NUM_PATTERN =
    '(?<num>(?<=SNR)\\s?[-+]?(?:3[01]|[0-2]?[0-9]))?';

  const DIRECTED_RE = new RegExp(
    '^' + CALLSIGN_PATTERN + OPTIONAL_CMD_PATTERN + OPTIONAL_NUM_PATTERN);
  const HEARTBEAT_RE = new RegExp(
    '^\\s*(?<callsign>[@](?:ALLCALL|HB)\\s+)?(?<type>CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT(?!\\s+SNR))(?:\\s(?<grid>[A-R]{2}[0-9]{2}))?\\b');
  const COMPOUND_RE = new RegExp(
    '^\\s*[`]' + CALLSIGN_PATTERN + '(?<extra>' + OPTIONAL_GRID_PATTERN +
    OPTIONAL_CMD_PATTERN + OPTIONAL_NUM_PATTERN + ')');

  const HUFF_TABLE = new Map([
    [' ', '01'], ['E', '100'], ['T', '1101'], ['A', '0011'], ['O', '11111'],
    ['I', '11100'], ['N', '10111'], ['S', '10100'], ['H', '00011'],
    ['R', '00000'], ['D', '111011'], ['L', '110011'], ['C', '110001'],
    ['U', '101101'], ['M', '101011'], ['W', '001011'], ['F', '001001'],
    ['G', '000101'], ['Y', '000011'], ['P', '1111011'], ['B', '1111001'],
    ['.', '1110100'], ['V', '1100101'], ['K', '1100100'], ['-', '1100001'],
    ['+', '1100000'], ['?', '1011001'], ['!', '1011000'], ['"', '1010101'],
    ['X', '1010100'], ['0', '0010101'], ['J', '0010100'], ['1', '0010001'],
    ['Q', '0010000'], ['2', '0001001'], ['Z', '0001000'], ['3', '0000101'],
    ['5', '0000100'], ['4', '11110101'], ['9', '11110100'], ['8', '11110001'],
    ['6', '11110000'], ['7', '11101011'], ['/', '11101010'],
  ]);

  const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;
  const NBASEGRID = 180 * 180;
  const NUSERGRID = NBASEGRID + 10;
  const NMAXGRID = (1 << 15) - 1;

  const BASECALLS = new Map([
    ['<....>', NBASECALL + 1],
    ['@ALLCALL', NBASECALL + 2], ['@JS8NET', NBASECALL + 3],
    ['@DX/NA', NBASECALL + 4], ['@DX/SA', NBASECALL + 5],
    ['@DX/EU', NBASECALL + 6], ['@DX/AS', NBASECALL + 7],
    ['@DX/AF', NBASECALL + 8], ['@DX/OC', NBASECALL + 9],
    ['@DX/AN', NBASECALL + 10],
    ['@REGION/1', NBASECALL + 11], ['@REGION/2', NBASECALL + 12],
    ['@REGION/3', NBASECALL + 13],
    ['@GROUP/0', NBASECALL + 14], ['@GROUP/1', NBASECALL + 15],
    ['@GROUP/2', NBASECALL + 16], ['@GROUP/3', NBASECALL + 17],
    ['@GROUP/4', NBASECALL + 18], ['@GROUP/5', NBASECALL + 19],
    ['@GROUP/6', NBASECALL + 20], ['@GROUP/7', NBASECALL + 21],
    ['@GROUP/8', NBASECALL + 22], ['@GROUP/9', NBASECALL + 23],
    ['@COMMAND', NBASECALL + 24], ['@CONTROL', NBASECALL + 25],
    ['@NET', NBASECALL + 26], ['@NTS', NBASECALL + 27],
    ['@RESERVE/0', NBASECALL + 28], ['@RESERVE/1', NBASECALL + 29],
    ['@RESERVE/2', NBASECALL + 30], ['@RESERVE/3', NBASECALL + 31],
    ['@RESERVE/4', NBASECALL + 32],
    ['@APRSIS', NBASECALL + 33], ['@RAGCHEW', NBASECALL + 34],
    ['@JS8', NBASECALL + 35], ['@EMCOMM', NBASECALL + 36],
    ['@ARES', NBASECALL + 37], ['@MARS', NBASECALL + 38],
    ['@AMRRON', NBASECALL + 39], ['@RACES', NBASECALL + 40],
    ['@RAYNET', NBASECALL + 41], ['@RADAR', NBASECALL + 42],
    ['@SKYWARN', NBASECALL + 43], ['@CQ', NBASECALL + 44],
    ['@HB', NBASECALL + 45], ['@QSO', NBASECALL + 46],
    ['@QSOPARTY', NBASECALL + 47], ['@CONTEST', NBASECALL + 48],
    ['@FIELDDAY', NBASECALL + 49], ['@SOTA', NBASECALL + 50],
    ['@IOTA', NBASECALL + 51], ['@POTA', NBASECALL + 52],
    ['@QRP', NBASECALL + 53], ['@QRO', NBASECALL + 54],
  ]);
  const BASECALLS_KEYS_SORTED = Array.from(BASECALLS.keys()).sort();

  const CQS = new Map([
    [0, 'CQ CQ CQ'], [1, 'CQ DX'], [2, 'CQ QRP'], [3, 'CQ CONTEST'],
    [4, 'CQ FIELD'], [5, 'CQ FD'], [6, 'CQ CQ'], [7, 'CQ'],
  ]);
  const HBS = new Map([
    [0, 'HB'], [1, 'HB'], [2, 'HB'], [3, 'HB'],
    [4, 'HB'], [5, 'HB'], [6, 'HB'], [7, 'HB'],
  ]);
  // QMap::key(value, default): first key in ascending key order.
  function mapKeyForValue(map, value, dflt) {
    const keys = Array.from(map.keys()).sort((a, b) => a - b);
    for (const k of keys) if (map.get(k) === value) return k;
    return dflt;
  }

  // ── bit vector helpers ────────────────────────────────────────────────────

  function intToBits(value, expected = 0) {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    const bits = [];
    while (v) {
      bits.unshift(Number(v & 1n));
      v >>= 1n;
    }
    while (bits.length < expected) bits.unshift(0);
    return bits;
  }

  function bitsToBig(bits) {
    let v = 0n;
    for (const b of bits) v = (v << 1n) | (b ? 1n : 0n);
    return v;
  }
  function bitsToInt(bits) {
    // Safe only below 2^53 — callers that can exceed use bitsToBig.
    return Number(bitsToBig(bits));
  }

  function strToBits(s) {
    const bits = [];
    for (const ch of s) bits.push(ch === '1' ? 1 : 0);
    return bits;
  }
  function bitsToStr(bits) {
    return bits.map((b) => (b ? '1' : '0')).join('');
  }

  // ── base-41 packing ───────────────────────────────────────────────────────

  function pack5bits(v) { return ALPHABET[v % 32]; }
  function unpack5bits(s) { return ALPHABET.indexOf(s[0]); }
  function pack6bits(v) { return ALPHABET[v % 41]; }
  function unpack6bits(s) { return ALPHABET.indexOf(s[0]); }

  function pack16bits(v) {
    let out = '';
    let tmp = Math.floor(v / (NALPHABET * NALPHABET));
    out += ALPHABET[tmp];
    tmp = Math.floor((v - tmp * NALPHABET * NALPHABET) / NALPHABET);
    out += ALPHABET[tmp];
    out += ALPHABET[v % NALPHABET];
    return out;
  }
  function unpack16bits(s) {
    const a = ALPHABET.indexOf(s[0]);
    const b = ALPHABET.indexOf(s[1]);
    const c = ALPHABET.indexOf(s[2]);
    const unpacked = NALPHABET * NALPHABET * a + NALPHABET * b + c;
    if (unpacked > 0xFFFF) return 0; // base-41 overflow ("???")
    return unpacked & 0xFFFF;
  }

  function pack32bits(v) {
    const a = Math.floor(v / 65536) & 0xFFFF;
    const b = v & 0xFFFF;
    return pack16bits(a) + pack16bits(b);
  }
  function unpack32bits(s) {
    return unpack16bits(s.slice(0, 3)) * 65536 + unpack16bits(s.slice(3, 6));
  }

  function pack64bits(v) {
    const big = typeof v === 'bigint' ? v : BigInt(v);
    const a = Number((big >> 32n) & 0xFFFFFFFFn);
    const b = Number(big & 0xFFFFFFFFn);
    return pack32bits(a) + pack32bits(b);
  }

  // 72-bit frame text: 12 chars of ALPHABET72. value = the first 64 bits,
  // rem = the last 8. Faithful to pack72bits/unpack72bits.
  function pack72bits(value, rem) {
    let v = typeof value === 'bigint' ? value : BigInt(value);
    const out = new Array(12);
    const remHigh = Number(((v & 0xFn) << 2n) | BigInt((rem >> 6) & 0x3));
    const remLow = rem & 0x3F;
    v >>= 4n;
    out[11] = ALPHABET72[remLow];
    out[10] = ALPHABET72[remHigh];
    for (let i = 0; i < 10; i++) {
      out[9 - i] = ALPHABET72[Number(v & 0x3Fn)];
      v >>= 6n;
    }
    return out.join('');
  }
  function unpack72bits(text) {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      value |= BigInt(ALPHABET72.indexOf(text[i])) << BigInt(58 - 6 * i);
    }
    const remHigh = ALPHABET72.indexOf(text[10]);
    value |= BigInt(remHigh >> 2);
    const remLow = ALPHABET72.indexOf(text[11]);
    const rem = ((remHigh & 0x3) << 6) | remLow;
    return { value, rem };
  }

  // ── alphanumeric50 (compound callsigns) ───────────────────────────────────

  function packAlphaNumeric50(value) {
    let word = String(value).replace(/[^A-Z0-9 /@]/g, '');
    if (word.length > 3 && word[3] !== '/') word = word.slice(0, 3) + ' ' + word.slice(3);
    if (word.length > 7 && word[7] !== '/') word = word.slice(0, 7) + ' ' + word.slice(7);
    while (word.length < 11) word += ' ';

    const AN = (c) => BigInt(ALPHANUMERIC.indexOf(c));
    const B38 = 38n;
    let packed = 0n;
    packed += B38 * B38 * B38 * 2n * B38 * B38 * B38 * 2n * B38 * B38 * AN(word[0]);
    packed += B38 * B38 * B38 * 2n * B38 * B38 * B38 * 2n * B38 * AN(word[1]);
    packed += B38 * B38 * B38 * 2n * B38 * B38 * B38 * 2n * AN(word[2]);
    packed += B38 * B38 * B38 * 2n * B38 * B38 * B38 * BigInt(word[3] === '/' ? 1 : 0);
    packed += B38 * B38 * B38 * 2n * B38 * B38 * AN(word[4]);
    packed += B38 * B38 * B38 * 2n * B38 * AN(word[5]);
    packed += B38 * B38 * B38 * 2n * AN(word[6]);
    packed += B38 * B38 * B38 * BigInt(word[7] === '/' ? 1 : 0);
    packed += B38 * B38 * AN(word[8]);
    packed += B38 * AN(word[9]);
    packed += AN(word[10]);
    return packed;
  }

  function unpackAlphaNumeric50(packed) {
    let v = typeof packed === 'bigint' ? packed : BigInt(packed);
    const word = new Array(11);
    const take = (n) => { const r = Number(v % n); v /= n; return r; };
    word[10] = ALPHANUMERIC[take(38n)];
    word[9] = ALPHANUMERIC[take(38n)];
    word[8] = ALPHANUMERIC[take(38n)];
    word[7] = take(2n) ? '/' : ' ';
    word[6] = ALPHANUMERIC[take(38n)];
    word[5] = ALPHANUMERIC[take(38n)];
    word[4] = ALPHANUMERIC[take(38n)];
    word[3] = take(2n) ? '/' : ' ';
    word[2] = ALPHANUMERIC[take(38n)];
    word[1] = ALPHANUMERIC[take(38n)];
    word[0] = ALPHANUMERIC[take(39n)];
    return word.join('').replace(/ /g, '');
  }

  // ── callsign28 ────────────────────────────────────────────────────────────

  function packCallsign(value) {
    let portable = false;
    let callsign = String(value).toUpperCase().trim();

    if (BASECALLS.has(callsign)) {
      return { packed: BASECALLS.get(callsign), portable };
    }
    if (callsign.endsWith('/P')) {
      callsign = callsign.slice(0, -2);
      portable = true;
    }
    if (callsign.startsWith('3DA0')) callsign = '3D0' + callsign.slice(4);
    if (callsign.startsWith('3X') && callsign[2] >= 'A' && callsign[2] <= 'Z') {
      callsign = 'Q' + callsign.slice(2);
    }

    const slen = callsign.length;
    if (slen < 2 || slen > 6) return { packed: 0, portable };

    const permutations = [callsign];
    if (slen === 2) permutations.push(' ' + callsign + '   ');
    if (slen === 3) { permutations.push(' ' + callsign + '  '); permutations.push(callsign + '   '); }
    if (slen === 4) { permutations.push(' ' + callsign + ' '); permutations.push(callsign + '  '); }
    if (slen === 5) { permutations.push(' ' + callsign); permutations.push(callsign + ' '); }

    let matched = '';
    const re = new RegExp(PACK_CALLSIGN_PATTERN);
    for (const p of permutations) {
      const m = re.exec(p);
      if (m) matched = m[0];
    }
    if (!matched || matched.length < 6) return { packed: 0, portable };

    let packed = ALPHANUMERIC.indexOf(matched[0]);
    packed = 36 * packed + ALPHANUMERIC.indexOf(matched[1]);
    packed = 10 * packed + ALPHANUMERIC.indexOf(matched[2]);
    packed = 27 * packed + ALPHANUMERIC.indexOf(matched[3]) - 10;
    packed = 27 * packed + ALPHANUMERIC.indexOf(matched[4]) - 10;
    packed = 27 * packed + ALPHANUMERIC.indexOf(matched[5]) - 10;
    return { packed, portable };
  }

  function unpackCallsign(value, portable) {
    for (const key of BASECALLS_KEYS_SORTED) {
      if (BASECALLS.get(key) === value) return key;
    }
    let v = value;
    const word = new Array(6);
    word[5] = ALPHANUMERIC[(v % 27) + 10]; v = Math.floor(v / 27);
    word[4] = ALPHANUMERIC[(v % 27) + 10]; v = Math.floor(v / 27);
    word[3] = ALPHANUMERIC[(v % 27) + 10]; v = Math.floor(v / 27);
    word[2] = ALPHANUMERIC[v % 10]; v = Math.floor(v / 10);
    word[1] = ALPHANUMERIC[v % 36]; v = Math.floor(v / 36);
    word[0] = ALPHANUMERIC[v];

    let callsign = word.join('');
    if (callsign.startsWith('3D0')) callsign = '3DA0' + callsign.slice(3);
    if (callsign.startsWith('Q') && callsign[1] >= 'A' && callsign[1] <= 'Z') {
      callsign = '3X' + callsign.slice(1);
    }
    if (portable) callsign = callsign.trim() + '/P';
    return callsign.trim();
  }

  // ── grid15 ────────────────────────────────────────────────────────────────

  function deg2grid(dlong, dlat) {
    if (dlong < -180) dlong += 360;
    if (dlong > 180) dlong -= 360;

    const nlong = Math.trunc((60.0 * (180.0 - dlong)) / 5);
    let n1 = Math.trunc(nlong / 240);
    let n2 = Math.trunc((nlong - 240 * n1) / 24);
    let n3 = nlong - 240 * n1 - 24 * n2;
    const g0 = String.fromCharCode(65 + n1);
    const g2 = String.fromCharCode(48 + n2);
    const g4 = String.fromCharCode(97 + n3);

    const nlat = Math.trunc((60.0 * (dlat + 90)) / 2.5);
    n1 = Math.trunc(nlat / 240);
    n2 = Math.trunc((nlat - 240 * n1) / 24);
    n3 = nlat - 240 * n1 - 24 * n2;
    const g1 = String.fromCharCode(65 + n1);
    const g3 = String.fromCharCode(48 + n2);
    const g5 = String.fromCharCode(97 + n3);

    return g0 + g1 + g2 + g3 + g4 + g5;
  }

  function grid2deg(grid) {
    let g = grid;
    if (g.length < 6) g = grid.slice(0, 4) + 'mm';
    g = g.slice(0, 4).toUpperCase() + g.slice(-2).toLowerCase();

    const nlong = 180 - 20 * (g.charCodeAt(0) - 65);
    const n20d = 2 * (g.charCodeAt(2) - 48);
    const xminlong = 5 * (g.charCodeAt(4) - 97 + 0.5);
    const dlong = nlong - n20d - xminlong / 60.0;

    const nlat = -90 + 10 * (g.charCodeAt(1) - 65) + (g.charCodeAt(3) - 48);
    const xminlat = 2.5 * (g.charCodeAt(5) - 97 + 0.5);
    const dlat = nlat + xminlat / 60.0;

    return { dlong, dlat };
  }

  function packGrid(value) {
    const grid = String(value).trim();
    if (grid.length < 4) return NMAXGRID;
    const { dlong, dlat } = grid2deg(grid.slice(0, 4));
    // C++ truncation order matters: ilong truncates the raw longitude, but
    // ilat truncates AFTER adding 90 (int ilat = pair.second + 90) — for
    // southern-hemisphere grids the two orders differ by one.
    const ilong = Math.trunc(dlong);
    const ilat = Math.trunc(dlat + 90);
    return Math.trunc((ilong + 180) / 2) * 180 + ilat;
  }

  function unpackGrid(value) {
    if (value > NBASEGRID) return '';
    const dlat = (value % 180) - 90;
    const dlong = Math.trunc(value / 180) * 2 - 180 + 2;
    return deg2grid(dlong, dlat).slice(0, 4);
  }

  // ── num / cmd packing ─────────────────────────────────────────────────────

  function packNum(num) {
    if (num === undefined || num === null || num === '') {
      return { inum: 0, ok: false };
    }
    const parsed = parseInt(num, 10);
    const ok = !Number.isNaN(parsed);
    const inum = Math.max(-30, Math.min(ok ? parsed : 0, 31));
    return { inum: inum + 30 + 1, ok };
  }

  function packCmd(cmd, num) {
    const cmdStr = cmdKeyForValue(cmd);
    if (isSNRCommand(cmdStr)) {
      // [1][X][6] — X=1 for HEARTBEAT SNR
      let value = ((1 << 1) | (cmdStr === ' HEARTBEAT SNR' ? 1 : 0)) << 6;
      value += num & 0x3F;
      return { value, packedNum: true };
    }
    return { value: cmd & 0x7F, packedNum: false };
  }

  function unpackCmd(value) {
    if (value & (1 << 7)) {
      const num = value & 0x3F;
      let cmd = DIRECTED_CMDS.get(' SNR');
      if (value & (1 << 6)) cmd = DIRECTED_CMDS.get(' HEARTBEAT SNR');
      return { cmd, num };
    }
    return { cmd: value & 0x7F, num: 0 };
  }

  // ── command classification ────────────────────────────────────────────────

  function isSNRCommand(cmd) {
    return DIRECTED_CMDS.has(cmd) && SNR_CMDS.has(DIRECTED_CMDS.get(cmd));
  }
  function isCommandAllowed(cmd) {
    return DIRECTED_CMDS.has(cmd) && ALLOWED_CMDS.has(DIRECTED_CMDS.get(cmd));
  }
  function isCommandBuffered(cmd) {
    return DIRECTED_CMDS.has(cmd) &&
      (cmd.includes(' ') || BUFFERED_CMDS.has(DIRECTED_CMDS.get(cmd)));
  }
  function isCommandChecksumed(cmd) {
    if (!DIRECTED_CMDS.has(cmd)) return 0;
    const v = DIRECTED_CMDS.get(cmd);
    return CHECKSUM_CMDS.has(v) ? CHECKSUM_CMDS.get(v) : 0;
  }
  function isCommandAutoreply(cmd) {
    return DIRECTED_CMDS.has(cmd) && AUTOREPLY_CMDS.has(DIRECTED_CMDS.get(cmd));
  }

  // ── callsign validation ───────────────────────────────────────────────────

  function isValidCompoundCallsign(callsign) {
    const slashes = (callsign.match(/\//g) || []).length;
    if (callsign.length - slashes > 9) return false;
    const idx = callsign.indexOf('/');
    if (idx !== -1) return !BASECALLS.has(callsign.slice(0, idx));
    if (callsign.startsWith('@')) return true;
    return callsign.length > 2 && /[0-9][A-Z]|[A-Z][0-9]/.test(callsign);
  }

  function isValidCallsign(callsign, out = {}) {
    out.isCompound = false;
    if (BASECALLS.has(callsign)) return true;

    let m = new RegExp(BASE_CALLSIGN_PATTERN).exec(callsign);
    if (m && m[0].length === callsign.length) {
      return callsign.length > 2 && /[0-9][A-Z]|[A-Z][0-9]/.test(callsign);
    }

    m = new RegExp('^' + COMPOUND_CALLSIGN_PATTERN).exec(callsign);
    if (m && m[0].length === callsign.length) {
      const isValid = isValidCompoundCallsign(m[0]);
      out.isCompound = isValid;
      return isValid;
    }
    return false;
  }

  function isCompoundCallsign(callsign) {
    if (BASECALLS.has(callsign) && !callsign.startsWith('@')) return false;
    let m = new RegExp(BASE_CALLSIGN_PATTERN).exec(callsign);
    if (m && m[0].length === callsign.length) return false;
    m = new RegExp('^' + COMPOUND_CALLSIGN_PATTERN).exec(callsign);
    if (!m || m[0].length !== callsign.length) return false;
    return isValidCompoundCallsign(m[0]);
  }

  function isGroupAllowed(group) {
    return group !== '@APRSIS' && group !== '@JS8NET';
  }

  // ── utilities ─────────────────────────────────────────────────────────────

  function lstrip(s) { return s.replace(/^\s+/, ''); }
  function rstrip(s) { return s.replace(/\s+$/, ''); }

  function formatSNR(snr) {
    if (snr < -60 || snr > 60) return '';
    // Qt: arg(snr, width, 10, '0') — width 3 when negative ("-05"), 2 else.
    const abs = Math.abs(snr);
    const sign = snr < 0 ? '-' : '+';
    return sign + String(abs).padStart(2, '0');
  }

  function cqString(number) { return CQS.has(number) ? CQS.get(number) : ''; }
  function hbString(number) { return HBS.has(number) ? HBS.get(number) : ''; }
  function startsWithCQ(text) {
    for (const cq of CQS.values()) if (text.startsWith(cq)) return true;
    return false;
  }
  function startsWithHB(text) {
    for (const hb of HBS.values()) if (text.startsWith(hb)) return true;
    return false;
  }

  function parseCallsigns(input) {
    const out = [];
    const re = new RegExp(COMPOUND_CALLSIGN_PATTERN, 'g');
    let m;
    while ((m = re.exec(input))) {
      const callsign = (m.groups.callsign || '').trim();
      if (!callsign) continue;
      if (!isValidCallsign(callsign)) continue;
      if (new RegExp(GRID_PATTERN).test(callsign)) continue;
      out.push(callsign);
    }
    return out;
  }

  function parseGrids(input) {
    const out = [];
    const re = new RegExp(GRID_PATTERN, 'g');
    let m;
    while ((m = re.exec(input))) {
      const grid = m.groups.grid;
      if (grid === 'RR73') continue;
      out.push(grid);
    }
    return out;
  }

  // ── checksums ─────────────────────────────────────────────────────────────
  // CRC-16/KERMIT (reflected 0x1021, init 0) and CRC-32/BZIP2
  // (unreflected 0x04C11DB7, init/xorout 0xFFFFFFFF), over latin-1 bytes.

  function crc16Kermit(str) {
    let crc = 0;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) & 0xFF;
      for (let b = 0; b < 8; b++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
      }
    }
    return crc & 0xFFFF;
  }

  function crc32Bzip2(str) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= (str.charCodeAt(i) & 0xFF) << 24;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04C11DB7) >>> 0 : (crc << 1) >>> 0;
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function checksum16(input) {
    let c = pack16bits(crc16Kermit(input));
    while (c.length < 3) c += ' ';
    return c;
  }
  function checksum16Valid(checksum, input) {
    return pack16bits(crc16Kermit(input)) === checksum;
  }
  function checksum32(input) {
    let c = pack32bits(crc32Bzip2(input));
    while (c.length < 6) c += ' ';
    return c;
  }
  function checksum32Valid(checksum, input) {
    return pack32bits(crc32Bzip2(input)) === checksum;
  }

  // ── Huffman coding ────────────────────────────────────────────────────────

  // Keys sorted by length descending, then reverse-lexicographic — the
  // comparator upstream uses before greedy matching.
  const HUFF_KEYS_SORTED = Array.from(HUFF_TABLE.keys()).sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return b < a ? -1 : b > a ? 1 : 0;
  });

  function huffEncode(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let found = false;
      for (const ch of HUFF_KEYS_SORTED) {
        if (text.startsWith(ch, i)) {
          out.push({ chars: ch.length, bits: strToBits(HUFF_TABLE.get(ch)) });
          i += ch.length;
          found = true;
          break;
        }
      }
      if (!found) i++;
    }
    return out;
  }

  function huffDecode(bits) {
    let text = '';
    let s = bitsToStr(bits);
    const keys = Array.from(HUFF_TABLE.keys()).sort();
    while (s.length > 0) {
      let found = false;
      for (const key of keys) {
        const code = HUFF_TABLE.get(key);
        if (s.startsWith(code)) {
          text += key;
          s = s.slice(code.length);
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return text;
  }

  function huffValidChars() { return new Set(HUFF_TABLE.keys()); }

  // ── JSC dense coding ──────────────────────────────────────────────────────
  // The 262144-word table is loaded lazily (2.4 MB JSON) and only when a
  // data frame actually needs it.

  let JSC_WORDS = null;       // index -> word
  let JSC_SIZES = null;       // index -> match length (usually word.length)
  let JSC_LOOKUP = null;      // word (exact, by match length) -> index
  let JSC_MAXLEN = 0;

  function jscLoad(words) {
    JSC_WORDS = new Array(words.length);
    JSC_SIZES = new Array(words.length);
    JSC_LOOKUP = new Map();
    JSC_MAXLEN = 0;
    for (let i = 0; i < words.length; i++) {
      const entry = words[i];
      const word = Array.isArray(entry) ? entry[0] : entry;
      const size = Array.isArray(entry) ? entry[1] : word.length;
      JSC_WORDS[i] = word;
      JSC_SIZES[i] = size;
      const key = word.slice(0, size);
      // First index wins — the C++ list scan finds the earliest match.
      if (!JSC_LOOKUP.has(key)) JSC_LOOKUP.set(key, i);
      if (size > JSC_MAXLEN) JSC_MAXLEN = size;
    }
  }

  function jscEnsure() {
    if (JSC_WORDS) return;
    if (typeof require !== 'undefined') {
      // eslint-disable-next-line global-require
      jscLoad(require('../assets/js8-jsc-map.json'));
    } else {
      throw new Error('JSC table not loaded — call Js8Varicode.jscLoad(words) first');
    }
  }

  // Longest-prefix lookup, equivalent to the C++ descending-lex list scan.
  function jscLookupPrefix(w) {
    jscEnsure();
    const cap = Math.min(w.length, JSC_MAXLEN);
    for (let len = cap; len >= 1; len--) {
      const idx = JSC_LOOKUP.get(w.slice(0, len));
      if (idx !== undefined) return { index: idx, size: len, ok: true };
    }
    return { index: 0, size: 0, ok: false };
  }

  function jscCodeword(index, separate, bytesize, s, c) {
    const out = [];
    const v = ((index % s) << 1) + (separate ? 1 : 0);
    out.unshift(intToBits(v, bytesize + 1));
    let x = Math.floor(index / s);
    while (x > 0) {
      x -= 1;
      out.unshift(intToBits((x % c) + s, bytesize));
      x = Math.floor(x / c);
    }
    return [].concat(...out);
  }

  function jscCompress(text) {
    jscEnsure();
    const out = [];
    const b = 4, s = 7, c = Math.pow(2, 4) - s;
    const words = text.split(' '); // KeepEmptyParts

    for (let i = 0, len = words.length; i < len; i++) {
      let w = words[i];
      const isLastWord = i === len - 1;
      let isSpaceCharacter = false;
      if (w === '' && !isLastWord) {
        w = ' ';
        isSpaceCharacter = true;
      }
      while (w.length > 0) {
        const { index, size, ok } = jscLookupPrefix(w);
        if (!ok) break;
        w = w.slice(size);
        const isLast = w.length === 0;
        const shouldAppendSpace = isLast && !isSpaceCharacter && !isLastWord;
        out.push({
          bits: jscCodeword(index, shouldAppendSpace, b, s, c),
          chars: size + (shouldAppendSpace ? 1 : 0),
        });
      }
    }
    return out;
  }

  function jscDecompress(bits) {
    jscEnsure();
    const s = 7, c = Math.pow(2, 4) - 7;
    const out = [];

    const base = [0];
    base[1] = s;
    base[2] = base[1] + s * c;
    base[3] = base[2] + s * c * c;
    base[4] = base[3] + s * c * c * c;
    base[5] = base[4] + s * c ** 4;
    base[6] = base[5] + s * c ** 5;
    base[7] = base[6] + s * c ** 6;

    const bytes = [];
    const separators = [];
    let i = 0;
    const count = bits.length;
    while (i < count) {
      const nib = bits.slice(i, i + 4);
      if (nib.length !== 4) break;
      const byte = bitsToInt(nib);
      bytes.push(byte);
      i += 4;
      if (byte < s) {
        if (count - i > 0 && bits[i]) separators.push(bytes.length - 1);
        i += 1;
      }
    }

    let start = 0;
    while (start < bytes.length) {
      let k = 0;
      let j = 0;
      while (start + k < bytes.length && bytes[start + k] >= s) {
        j = j * c + (bytes[start + k] - s);
        k++;
      }
      if (j >= JSC_WORDS.length) break;
      if (start + k >= bytes.length) break;
      j = j * s + bytes[start + k] + base[k];
      if (j >= JSC_WORDS.length) break;

      out.push(JSC_WORDS[j]);
      if (separators.length && separators[0] === start + k) {
        out.push(' ');
        separators.shift();
      }
      start = start + k + 1;
    }
    return out.join('');
  }

  // ── frame packing: heartbeat / compound / directed / data ─────────────────

  function packHeartbeatMessage(text, callsign) {
    const m = HEARTBEAT_RE.exec(text);
    if (!m) return { frame: '', n: 0 };

    const extra = m.groups.grid || '';
    const type = m.groups.type;
    const isAlt = type.startsWith('CQ');
    if (!callsign) return { frame: '', n: 0 };

    let packedExtra = NMAXGRID;
    if (extra.length === 4 && new RegExp(GRID_PATTERN).test(extra)) {
      packedExtra = packGrid(extra);
    }
    let cqNumber = mapKeyForValue(HBS, type, 0);
    if (isAlt) {
      packedExtra |= 1 << 15;
      cqNumber = mapKeyForValue(CQS, type, 0);
    }

    const frame = packCompoundFrame(callsign, FrameType.FrameHeartbeat,
      packedExtra, cqNumber);
    if (!frame) return { frame: '', n: 0 };
    return { frame, n: m[0].length };
  }

  function unpackHeartbeatMessage(text) {
    const r = unpackCompoundFrame(text);
    if (!r || r.type !== FrameType.FrameHeartbeat) return null;
    return {
      parts: [r.callsign, '', unpackGrid(r.num & 0x7FFF)],
      type: r.type,
      isAlt: !!(r.num & (1 << 15)),
      bits3: r.bits3,
    };
  }

  function packCompoundMessage(text) {
    const m = COMPOUND_RE.exec(text);
    if (!m) return { frame: '', n: 0 };

    const callsign = m.groups.callsign || '';
    const grid = m.groups.grid || '';
    const cmd = m.groups.cmd || '';
    const num = (m.groups.num || '').trim();
    if (!callsign) return { frame: '', n: 0 };

    let type = FrameType.FrameCompound;
    let extra = NMAXGRID;

    if (cmd && DIRECTED_CMDS.has(cmd) && isCommandAllowed(cmd)) {
      const { inum } = packNum(num);
      const packed = packCmd(DIRECTED_CMDS.get(cmd), inum);
      extra = NUSERGRID + packed.value;
      type = FrameType.FrameCompoundDirected;
    } else if (grid) {
      extra = packGrid(grid);
    }

    const frame = packCompoundFrame(callsign, type, extra, 0);
    return { frame, n: m[0].length };
  }

  function unpackCompoundMessage(text) {
    const r = unpackCompoundFrame(text);
    if (!r || (r.type !== FrameType.FrameCompound &&
               r.type !== FrameType.FrameCompoundDirected)) return null;

    const parts = [r.callsign, ''];
    if (r.num <= NBASEGRID) {
      parts.push(' ' + unpackGrid(r.num));
    } else if (r.num >= NUSERGRID && r.num < NMAXGRID) {
      const { cmd, num } = unpackCmd(r.num - NUSERGRID);
      const cmdStr = cmdKeyForValue(cmd);
      parts.push(cmdStr);
      if (isSNRCommand(cmdStr)) parts.push(formatSNR(num - 31));
    }
    return { parts, type: r.type, bits3: r.bits3 };
  }

  function packCompoundFrame(callsign, type, num, bits3) {
    if (type === FrameType.FrameData || type === FrameType.FrameDirected) return '';
    const packedCallsign = packAlphaNumeric50(callsign);
    if (packedCallsign === 0n) return '';

    const mask11 = ((1 << 11) - 1) << 5;
    const mask5 = (1 << 5) - 1;
    const packed11 = (num & mask11) >> 5;
    const packed5 = num & mask5;
    const packed8 = (packed5 << 3) | bits3;

    // [3][50][11],[5][3] = 72
    const bits = intToBits(type, 3)
      .concat(intToBits(packedCallsign, 50))
      .concat(intToBits(packed11, 11));
    return pack72bits(bitsToBig(bits), packed8);
  }

  function unpackCompoundFrame(text) {
    if (text.length < 12 || text.includes(' ')) return null;

    const { value, rem } = unpack72bits(text);
    const bits = intToBits(value, 64);
    const packed5 = rem >> 3;
    const packed3 = rem & 0x7;

    const flag = bitsToInt(bits.slice(0, 3));
    if (flag === FrameType.FrameData || flag === FrameType.FrameDirected) return null;

    const packedCallsign = bitsToBig(bits.slice(3, 53));
    const packed11 = bitsToInt(bits.slice(53, 64));
    const callsign = unpackAlphaNumeric50(packedCallsign);
    const num = (packed11 << 5) | packed5;

    return { callsign, type: flag, num, bits3: packed3 };
  }

  function packDirectedMessage(text, mycall) {
    const m = DIRECTED_RE.exec(text);
    if (!m) return { frame: '', n: 0 };

    let from = mycall;
    const isFromCompound = isCompoundCallsign(from);
    if (isFromCompound) from = '<....>';
    let to = m.groups.callsign || '';
    const cmd = m.groups.cmd !== undefined ? m.groups.cmd : '';
    const num = m.groups.num !== undefined ? m.groups.num : '';

    if (!cmd) return { frame: '', n: 0 };

    const toOut = {};
    const validTo = to !== mycall && isValidCallsign(to, toOut);
    if (!validTo) return { frame: '', n: 0 };
    const isToCompound = toOut.isCompound;
    const dirTo = to;
    if (isToCompound) to = '<....>';

    if (!isCommandAllowed(cmd) && !isCommandAllowed(cmd.trim())) {
      return { frame: '', n: 0 };
    }

    const { inum, ok: numOK } = packNum(num.trim());

    const fromPack = packCallsign(from);
    const toPack = packCallsign(to);
    if (fromPack.packed === 0 || toPack.packed === 0) return { frame: '', n: 0 };

    let cmdOut = '';
    let packedCmd = 0;
    if (DIRECTED_CMDS.has(cmd)) { cmdOut = cmd; packedCmd = DIRECTED_CMDS.get(cmd); }
    if (DIRECTED_CMDS.has(cmd.trim())) { cmdOut = cmd.trim(); packedCmd = DIRECTED_CMDS.get(cmd.trim()); }

    const packedExtra = ((fromPack.portable ? 1 : 0) << 7) +
      ((toPack.portable ? 1 : 0) << 6) + inum;

    // [3][28][28][5],[2][6] = 72
    const bits = intToBits(FrameType.FrameDirected, 3)
      .concat(intToBits(fromPack.packed, 28))
      .concat(intToBits(toPack.packed, 28))
      .concat(intToBits(((packedCmd % 32) + 32) % 32, 5));

    return {
      frame: pack72bits(bitsToBig(bits), packedExtra),
      n: m[0].length,
      to: dirTo,
      toCompound: isToCompound,
      cmd: cmdOut,
      num: numOK ? num : '',
    };
  }

  function unpackDirectedMessage(text) {
    if (text.length < 12 || text.includes(' ')) return null;

    const { value, rem } = unpack72bits(text);
    const bits = intToBits(value, 64);

    const flag = bitsToInt(bits.slice(0, 3));
    if (flag !== FrameType.FrameDirected) return null;

    const packedFrom = bitsToInt(bits.slice(3, 31));
    const packedTo = bitsToInt(bits.slice(31, 59));
    const packedCmd = bitsToInt(bits.slice(59, 64));

    const portableFrom = ((rem >> 7) & 1) === 1;
    const portableTo = ((rem >> 6) & 1) === 1;
    const extra = rem % 64;

    const parts = [
      unpackCallsign(packedFrom, portableFrom),
      unpackCallsign(packedTo, portableTo),
      cmdKeyForValue(packedCmd % 32),
    ];
    if (extra !== 0) {
      if (isSNRCommand(parts[2])) parts.push(formatSNR(extra - 31));
      else parts.push(String(extra - 31));
    }
    return { parts, type: flag };
  }

  // Data frames. The [1][1][70] header: first bit = data flag (the encoded
  // [100] type's zeros are reused as payload), second = compressed flag.
  const FRAME_SIZE = 72;

  function packBitsFrame(frameBits) {
    let pad = FRAME_SIZE - frameBits.length;
    if (pad) {
      for (let i = 0; i < pad; i++) frameBits.push(i === 0 ? 0 : 1);
    }
    const value = bitsToBig(frameBits.slice(0, 64));
    const rem = bitsToInt(frameBits.slice(64, 72));
    return pack72bits(value, rem);
  }

  function packHuffMessage(input, prefix) {
    const frameBits = prefix.slice();
    let i = 0;

    const validChars = huffValidChars();
    for (const ch of input) {
      if (!validChars.has(ch.toUpperCase())) return { frame: '', n: 0 };
    }

    for (const pair of huffEncode(input)) {
      if (frameBits.length + pair.bits.length < FRAME_SIZE) {
        frameBits.push(...pair.bits);
        i += pair.chars;
        continue;
      }
      break;
    }
    return { frame: packBitsFrame(frameBits), n: i };
  }

  function packCompressedMessage(input, prefix) {
    const frameBits = prefix.slice();
    let i = 0;
    for (const pair of jscCompress(input)) {
      if (frameBits.length + pair.bits.length < FRAME_SIZE) {
        frameBits.push(...pair.bits);
        i += pair.chars;
        continue;
      }
      break;
    }
    return { frame: packBitsFrame(frameBits), n: i };
  }

  function packDataMessage(input) {
    const huff = packHuffMessage(input, [1, 0]);
    const comp = packCompressedMessage(input, [1, 1]);
    return huff.n > comp.n ? huff : comp;
  }

  function unpackDataMessage(text) {
    if (text.length < 12 || text.includes(' ')) return '';
    const { value, rem } = unpack72bits(text);
    let bits = intToBits(value, 64).concat(intToBits(rem, 8));

    if (!bits[0]) return ''; // not data
    bits = bits.slice(1);

    const compressed = bits[0];
    const n = bits.lastIndexOf(0);
    bits = bits.slice(1, n === -1 ? 0 : n);

    return compressed ? jscDecompress(bits) : huffDecode(bits);
  }

  function packFastDataMessage(input) {
    // fast data always uses dense coding, no prefix (flagged by itype)
    return packCompressedMessage(input, []);
  }

  function unpackFastDataMessage(text) {
    if (text.length < 12 || text.includes(' ')) return '';
    const { value, rem } = unpack72bits(text);
    let bits = intToBits(value, 64).concat(intToBits(rem, 8));
    const n = bits.lastIndexOf(0);
    bits = bits.slice(0, n === -1 ? 0 : n);
    return jscDecompress(bits);
  }

  // ── message -> frames (buildMessageFrames) ────────────────────────────────

  function buildMessageFrames({ mycall, mygrid, selectedCall = '', text,
                                forceIdentify = false, forceData = false,
                                submode = SubmodeType.JS8CallNormal }) {
    const mycallCompound = isCompoundCallsign(mycall);
    const allFrames = [];
    const info = { dirTo: '', dirCmd: '', dirNum: '' };

    let line = text;
    const lineFrames = [];
    let hasDirected = false;
    let hasData = false;
    if (forceData) { forceIdentify = false; hasData = true; }

    // remove our callsign from the start of the line...
    if (line.startsWith(mycall + ':') || line.startsWith(mycall + ' ')) {
      line = lstrip(line.slice(mycall.length + 1));
    }

    // auto-prepend the selected call if the line doesn't address anyone
    if (selectedCall && !line.startsWith(selectedCall) &&
        !line.startsWith('`') && !forceData) {
      const startsWithBase = line.startsWith('@ALLCALL') ||
        startsWithCQ(line) || startsWithHB(line);
      const calls = parseCallsigns(line);
      const startsWithStandard = calls.length > 0 &&
        line.startsWith(calls[0]) && calls[0].length > 3;
      if (!startsWithBase && !startsWithStandard) {
        const sep = line.startsWith(' ') ? '' : ' ';
        line = selectedCall + sep + line;
      }
    }

    while (line.length > 0) {
      const bcn = packHeartbeatMessage(line, mycall);
      const cmp = packCompoundMessage(line);
      const dir = packDirectedMessage(line, mycall);

      // if we're sending a data message, ensure our callsign is included
      const isLikelyDataFrame = lineFrames.length === 0 && !selectedCall &&
        !(dir.to) && bcn.n === 0 && cmp.n === 0;
      if (forceIdentify && isLikelyDataFrame && !line.includes(mycall)) {
        line = mycall + ': ' + line;
        continue; // re-evaluate with the identity prefix in place
      }

      const isNormal = submode === SubmodeType.JS8CallNormal;
      const dat = isNormal ? packDataMessage(line) : packFastDataMessage(line);
      const fastDataFrame = !isNormal;

      if (!hasDirected && !hasData && bcn.n > 0) {
        lineFrames.push({ frame: bcn.frame, bits: TransmissionType.JS8Call });
        line = line.slice(bcn.n);
      } else if (!hasDirected && !hasData && cmp.n > 0) {
        lineFrames.push({ frame: cmp.frame, bits: TransmissionType.JS8Call });
        line = line.slice(cmp.n);
      } else if (!hasDirected && !hasData && dir.n > 0) {
        hasDirected = true;

        if (mycallCompound || dir.toCompound) {
          // compound cases: standard compound frame first, then a compound
          // directed frame (see upstream CASE 0-3 discussion)
          const deCompound = packCompoundMessage('`' + mycall + ' ' + (mygrid || ''));
          if (deCompound.frame) {
            lineFrames.push({ frame: deCompound.frame, bits: TransmissionType.JS8Call });
          }
          const dirCompound = packCompoundMessage('`' + dir.to + dir.cmd + dir.num);
          if (dirCompound.frame) {
            lineFrames.push({ frame: dirCompound.frame, bits: TransmissionType.JS8Call });
          }
        } else {
          lineFrames.push({ frame: dir.frame, bits: TransmissionType.JS8Call });
        }
        line = line.slice(dir.n);

        // checksum buffered commands that carry line data
        if (isCommandBuffered(dir.cmd) && line.length > 0) {
          line = lstrip(line);
          const skipAprs = dir.to.toUpperCase() === '@APRSIS' &&
            (dir.cmd === ' MSG' || dir.cmd === ' MSG TO:');
          const checksumSize = skipAprs ? 0 : isCommandChecksumed(dir.cmd);
          if (checksumSize === 32) line = line + ' ' + checksum32(line);
          else if (checksumSize === 16) line = line + ' ' + checksum16(line);
        }

        info.dirCmd = dir.cmd;
        info.dirTo = dir.to;
        info.dirNum = dir.num;
      } else if (dat.n > 0) {
        hasData = true;
        lineFrames.push({
          frame: dat.frame,
          bits: fastDataFrame ? TransmissionType.JS8CallData : TransmissionType.JS8Call,
        });
        line = line.slice(dat.n);
      } else {
        break; // nothing could consume any of the line — refuse to loop
      }
    }

    if (lineFrames.length) {
      lineFrames[0].bits |= TransmissionType.JS8CallFirst;
      lineFrames[lineFrames.length - 1].bits |= TransmissionType.JS8CallLast;
    }
    allFrames.push(...lineFrames);

    return { frames: allFrames, info };
  }

  // ── frame -> message (the DecodedText logic) ──────────────────────────────

  const QUALITY_THRESHOLD = 0.17;

  function buildCompoundCall(parts) {
    return parts.slice(0, 2).filter((p) => p !== '').join('/');
  }

  // Interpret one decoded frame. `frame` is the 12-char text, `bits` the
  // itype (JS8CallFirst/Last/Data flags), `submode` the decoder mode.
  // Strategy order matches DecodedText::unpackStrategies exactly.
  function interpretFrame(frame, bits, submode) {
    const out = {
      frame,
      bits,
      submode,
      frameType: FrameType.FrameUnknown,
      message: frame,
      compound: '',
      directed: null,
      extra: '',
      isHeartbeat: false,
      isAlt: false,
      isFirst: !!(bits & TransmissionType.JS8CallFirst),
      isLast: !!(bits & TransmissionType.JS8CallLast),
    };

    const m = frame.trim();
    if (m.length < 12 || m.includes(' ')) return out;

    const isDataBits = (bits & TransmissionType.JS8CallData) === TransmissionType.JS8CallData;

    // 1. fast data
    if (isDataBits) {
      const data = unpackFastDataMessage(m);
      if (data) {
        out.message = data;
        out.frameType = FrameType.FrameData;
        return out;
      }
    }

    // 2. normal data
    if (!isDataBits) {
      const data = unpackDataMessage(m);
      if (data) {
        out.message = data;
        out.frameType = FrameType.FrameData;
        return out;
      }
    }

    // 3. heartbeat
    if (!isDataBits) {
      const hb = unpackHeartbeatMessage(m);
      if (hb && hb.parts.length >= 2) {
        out.frameType = hb.type;
        out.isHeartbeat = true;
        out.isAlt = hb.isAlt;
        out.extra = hb.parts[2] || '';
        out.compound = buildCompoundCall(hb.parts);
        out.message = out.compound + ': ';
        if (hb.isAlt) {
          out.message += '@ALLCALL ' + cqString(hb.bits3);
        } else {
          const sbits3 = hbString(hb.bits3);
          out.message += '@HB ' + (sbits3 === 'HB' ? 'HEARTBEAT' : sbits3);
        }
        out.message += ' ' + out.extra + ' ';
        return out;
      }
    }

    // 4. compound
    {
      const cf = unpackCompoundMessage(m);
      if (cf && cf.parts.length >= 2 && !isDataBits) {
        out.frameType = cf.type;
        out.extra = cf.parts.slice(2).join(' ');
        out.compound = buildCompoundCall(cf.parts);
        if (cf.type === FrameType.FrameCompound) {
          out.message = out.compound + ': ';
        } else if (cf.type === FrameType.FrameCompoundDirected) {
          out.message = out.compound + out.extra + ' ';
          out.directed = ['<....>', out.compound].concat(cf.parts.slice(2));
        }
        return out;
      }
    }

    // 5. directed
    if (!isDataBits) {
      const dm = unpackDirectedMessage(m);
      if (dm && dm.parts.length) {
        const parts = dm.parts;
        if (parts.length === 3 || parts.length === 4) {
          out.message = parts[0] + ': ' + parts[1] +
            parts.slice(2).join(' ') + ' ';
        } else {
          out.message = parts.join('');
        }
        out.directed = parts;
        out.frameType = dm.type;
        return out;
      }
    }

    return out;
  }

  function frameTypeString(type) {
    switch (type) {
      case FrameType.FrameHeartbeat: return 'heartbeat';
      case FrameType.FrameCompound: return 'compound';
      case FrameType.FrameCompoundDirected: return 'compound directed';
      case FrameType.FrameDirected: return 'directed';
      case FrameType.FrameData: return 'data';
      case FrameType.FrameDataCompressed: return 'data compressed';
      default: return 'unknown';
    }
  }

  return {
    FrameType, TransmissionType, SubmodeType,
    QUALITY_THRESHOLD,
    ALPHABET, ALPHABET72, ALPHANUMERIC,
    // bit helpers (exposed for tests)
    intToBits, bitsToInt, bitsToBig, strToBits, bitsToStr,
    pack5bits, unpack5bits, pack6bits, unpack6bits,
    pack16bits, unpack16bits, pack32bits, unpack32bits, pack64bits,
    pack72bits, unpack72bits,
    packAlphaNumeric50, unpackAlphaNumeric50,
    packCallsign, unpackCallsign,
    deg2grid, grid2deg, packGrid, unpackGrid,
    packNum, packCmd, unpackCmd,
    isSNRCommand, isCommandAllowed, isCommandBuffered, isCommandChecksumed,
    isCommandAutoreply, isValidCallsign, isCompoundCallsign, isGroupAllowed,
    formatSNR, cqString, hbString, startsWithCQ, startsWithHB,
    parseCallsigns, parseGrids, lstrip, rstrip,
    checksum16, checksum16Valid, checksum32, checksum32Valid,
    huffEncode, huffDecode,
    jscLoad, jscCompress, jscDecompress, jscCodeword,
    packHeartbeatMessage, unpackHeartbeatMessage,
    packCompoundMessage, unpackCompoundMessage,
    packCompoundFrame, unpackCompoundFrame,
    packDirectedMessage, unpackDirectedMessage,
    packDataMessage, unpackDataMessage,
    packFastDataMessage, unpackFastDataMessage,
    buildMessageFrames, interpretFrame, frameTypeString,
  };
});
