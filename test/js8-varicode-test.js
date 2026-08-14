#!/usr/bin/env node
'use strict';
/**
 * JS8 message codec (lib/js8-varicode.js — the JS port of JS8Call's
 * Varicode/JSC/DecodedText).
 *
 * The rule worth protecting: every frame this layer PACKS must be
 * interpretable by its own unpack path AND must survive the real modem
 * (12-char frame -> 79 tones -> audio -> decode -> 12-char frame), because
 * the two halves were written by different hands against the same GPL
 * source and a disagreement between them is silent on-air garbage.
 *
 * Run: node test/js8-varicode-test.js
 */

const assert = require('assert');
const V = require('../lib/js8-varicode');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// ── primitives ───────────────────────────────────────────────────────────────

test('pack72bits/unpack72bits round trip the full 72-bit space edges', () => {
  for (const [value, rem] of [[0n, 0], [1n, 0], [0n, 255],
    [(1n << 64n) - 1n, 255], [0x123456789ABCDEFn, 0x5A]]) {
    const text = V.pack72bits(value, rem);
    assert.strictEqual(text.length, 12);
    const r = V.unpack72bits(text);
    assert.strictEqual(r.value, value, `value for ${value}/${rem}`);
    assert.strictEqual(r.rem, rem, `rem for ${value}/${rem}`);
  }
});

test('pack16/32 round trip', () => {
  for (const v of [0, 1, 255, 4096, 65535]) {
    assert.strictEqual(V.unpack16bits(V.pack16bits(v)), v);
  }
  for (const v of [0, 65536, 0xDEADBEEF, 0xFFFFFFFF]) {
    assert.strictEqual(V.unpack32bits(V.pack32bits(v)), v);
  }
});

test('base-41 overflow unpacks to 0, not garbage', () => {
  assert.strictEqual(V.unpack16bits('???'), 0);
});

test('callsign28 round trips the shapes hams actually have', () => {
  for (const call of ['K3SBP', 'W1AW', 'KN4CRD', 'VE3ABC', 'G0ABC',
    'JA1ABC', 'K1A', '2E0ABC']) {
    const { packed, portable } = V.packCallsign(call);
    assert.ok(packed !== 0, call + ' should pack');
    assert.strictEqual(V.unpackCallsign(packed, portable), call, call);
  }
});

test('portable /P survives the flag path', () => {
  const { packed, portable } = V.packCallsign('K3SBP/P');
  assert.strictEqual(portable, true);
  assert.strictEqual(V.unpackCallsign(packed, true), 'K3SBP/P');
});

test('the Swaziland and Guinea workarounds still apply', () => {
  const swazi = V.packCallsign('3DA0AB');
  assert.ok(swazi.packed !== 0);
  assert.strictEqual(V.unpackCallsign(swazi.packed, false), '3DA0AB');
  const guinea = V.packCallsign('3XA1AB');
  assert.ok(guinea.packed !== 0);
  assert.strictEqual(V.unpackCallsign(guinea.packed, false), '3XA1AB');
});

test('group calls resolve through the basecall table', () => {
  const { packed } = V.packCallsign('@ALLCALL');
  assert.ok(packed !== 0);
  assert.strictEqual(V.unpackCallsign(packed, false), '@ALLCALL');
  const pota = V.packCallsign('@POTA');
  assert.strictEqual(V.unpackCallsign(pota.packed, false), '@POTA');
});

test('alphanumeric50 round trips compound callsigns', () => {
  for (const call of ['KN4CRD/QRP', 'VE3/LB9YH', 'K3SBP/P', '@RACES']) {
    const packed = V.packAlphaNumeric50(call);
    assert.ok(packed !== 0n, call);
    assert.strictEqual(V.unpackAlphaNumeric50(packed), call, call);
  }
});

test('grid15 round trips four-character grids', () => {
  for (const grid of ['FN20', 'EM73', 'AA00', 'RR99', 'JO01', 'IO91']) {
    const packed = V.packGrid(grid);
    assert.ok(packed <= 180 * 180, grid);
    assert.strictEqual(V.unpackGrid(packed), grid, grid);
  }
});

test('a missing grid packs to the sentinel and unpacks to nothing', () => {
  assert.strictEqual(V.packGrid(''), (1 << 15) - 1);
  assert.strictEqual(V.unpackGrid((1 << 15) - 1), '');
});

test('formatSNR matches the wire format', () => {
  assert.strictEqual(V.formatSNR(5), '+05');
  assert.strictEqual(V.formatSNR(-12), '-12');
  assert.strictEqual(V.formatSNR(0), '+00');
  assert.strictEqual(V.formatSNR(-5), '-05');
  assert.strictEqual(V.formatSNR(99), '');
});

test('callsign validation accepts real calls and rejects words', () => {
  assert.ok(V.isValidCallsign('K3SBP'));
  assert.ok(V.isValidCallsign('KN4CRD'));
  assert.ok(V.isValidCallsign('@ALLCALL'));
  const out = {};
  assert.ok(V.isValidCallsign('KN4CRD/QRP', out));
  assert.ok(out.isCompound);
  assert.ok(!V.isValidCallsign('HELLO', {}));
  assert.ok(!V.isValidCallsign('THE', {}));
});

// ── heartbeat frames ─────────────────────────────────────────────────────────

test('HB with grid round trips', () => {
  const { frame, n } = V.packHeartbeatMessage('HB FN20', 'K3SBP');
  assert.ok(frame, 'should pack');
  assert.ok(n > 0);
  const hb = V.unpackHeartbeatMessage(frame);
  assert.ok(hb, 'should unpack');
  assert.strictEqual(hb.parts[0], 'K3SBP');
  assert.strictEqual(hb.parts[2], 'FN20');
  assert.strictEqual(hb.isAlt, false);
});

test('CQ is the alt-flagged heartbeat', () => {
  const { frame } = V.packHeartbeatMessage('CQ CQ CQ EM73', 'KN4CRD');
  const hb = V.unpackHeartbeatMessage(frame);
  assert.ok(hb);
  assert.strictEqual(hb.isAlt, true);
  assert.strictEqual(hb.parts[2], 'EM73');
  // the bits3 carries WHICH cq variant
  assert.strictEqual(V.cqString(hb.bits3), 'CQ CQ CQ');
});

test('interpretFrame renders a heartbeat like JS8Call renders it', () => {
  const { frame } = V.packHeartbeatMessage('HB FN20', 'K3SBP');
  const d = V.interpretFrame(frame, 3, 0); // FIRST|LAST
  assert.strictEqual(d.frameType, V.FrameType.FrameHeartbeat);
  assert.ok(d.isHeartbeat);
  assert.strictEqual(d.compound, 'K3SBP');
  assert.strictEqual(d.message, 'K3SBP: @HB HEARTBEAT FN20 ');
});

test('interpretFrame renders CQ via @ALLCALL', () => {
  const { frame } = V.packHeartbeatMessage('CQ CQ CQ EM73', 'KN4CRD');
  const d = V.interpretFrame(frame, 3, 0);
  assert.strictEqual(d.message, 'KN4CRD: @ALLCALL CQ CQ CQ EM73 ');
});

// ── directed frames ──────────────────────────────────────────────────────────

test('a directed SNR query round trips', () => {
  const r = V.packDirectedMessage('KN4CRD SNR?', 'K3SBP');
  assert.ok(r.frame, 'should pack');
  assert.strictEqual(r.cmd, ' SNR?');
  const d = V.unpackDirectedMessage(r.frame);
  assert.ok(d);
  assert.strictEqual(d.parts[0], 'K3SBP');
  assert.strictEqual(d.parts[1], 'KN4CRD');
  assert.strictEqual(d.parts[2], ' SNR?');
});

test('a directed SNR report carries its number', () => {
  const r = V.packDirectedMessage('KN4CRD SNR -12', 'K3SBP');
  assert.ok(r.frame);
  const d = V.unpackDirectedMessage(r.frame);
  assert.strictEqual(d.parts[2], ' SNR');
  assert.strictEqual(d.parts[3], '-12');
});

test('directed 73 renders as JS8Call renders it', () => {
  const r = V.packDirectedMessage('KN4CRD 73', 'K3SBP');
  assert.ok(r.frame);
  const d = V.interpretFrame(r.frame, 3, 0);
  assert.strictEqual(d.frameType, V.FrameType.FrameDirected);
  assert.strictEqual(d.message, 'K3SBP: KN4CRD 73 ');
});

test('free text after a callsign is a directed freetext frame', () => {
  const r = V.packDirectedMessage('KN4CRD HELLO', 'K3SBP');
  // " HELLO" is not a command — the cmd match is the free-text space
  assert.ok(r.frame);
  const d = V.unpackDirectedMessage(r.frame);
  assert.strictEqual(d.parts[2], ' ');
});

// ── data frames ──────────────────────────────────────────────────────────────

test('huffman data frame round trips short text', () => {
  const { frame, n } = V.packDataMessage('HELLO WORLD');
  assert.ok(frame);
  assert.ok(n > 0);
  const text = V.unpackDataMessage(frame);
  assert.strictEqual(text, 'HELLO WORLD'.slice(0, n));
});

test('JSC dense coding round trips common words', () => {
  const pairs = V.jscCompress('THE QUICK BROWN FOX');
  assert.ok(pairs.length > 0);
  const bits = [].concat(...pairs.map((p) => p.bits));
  const text = V.jscDecompress(bits);
  assert.strictEqual(text, 'THE QUICK BROWN FOX');
});

test('fast data frame round trips', () => {
  const { frame, n } = V.packFastDataMessage('TEST DE K3SBP');
  assert.ok(frame);
  const text = V.unpackFastDataMessage(frame);
  assert.strictEqual(text, 'TEST DE K3SBP'.slice(0, n));
});

test('interpretFrame honors the fast-data itype flag', () => {
  const { frame } = V.packFastDataMessage('TEST');
  const d = V.interpretFrame(frame, V.TransmissionType.JS8CallData, 1);
  assert.strictEqual(d.frameType, V.FrameType.FrameData);
  assert.strictEqual(d.message, 'TEST');
});

// ── buildMessageFrames: text in, frames out ──────────────────────────────────

test('an HB line builds exactly one frame flagged first+last', () => {
  const { frames } = V.buildMessageFrames({
    mycall: 'K3SBP', mygrid: 'FN20', text: 'HB FN20',
  });
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].bits,
    V.TransmissionType.JS8CallFirst | V.TransmissionType.JS8CallLast);
});

test('a long message chains directed + data frames', () => {
  const { frames, info } = V.buildMessageFrames({
    mycall: 'K3SBP', mygrid: 'FN20',
    text: 'KN4CRD MSG HELLO FROM POTACAT',
  });
  assert.ok(frames.length >= 2, `got ${frames.length} frames`);
  assert.strictEqual(info.dirTo, 'KN4CRD');
  assert.strictEqual(info.dirCmd, ' MSG');
  // first frame directed, rest data; first/last flags on the ends
  assert.ok(frames[0].bits & V.TransmissionType.JS8CallFirst);
  assert.ok(frames[frames.length - 1].bits & V.TransmissionType.JS8CallLast);
});

test('compact directed SNR ACKs stay in one frame', () => {
  const compact = V.buildMessageFrames({
    mycall: 'K3SBP', mygrid: 'FN20', text: 'KE2DMC SNR -12',
  });
  const colon = V.buildMessageFrames({
    mycall: 'K3SBP', mygrid: 'FN20', text: 'KE2DMC: SNR -12',
  });
  assert.strictEqual(compact.frames.length, 1,
    'HB ACKs must use compact directed SNR form to avoid two on-air periods');
  const decoded = V.interpretFrame(compact.frames[0].frame, compact.frames[0].bits, 0);
  assert.strictEqual(decoded.frameType, V.FrameType.FrameDirected);
  assert.strictEqual(decoded.message, 'K3SBP: KE2DMC SNR -12 ');
  assert.ok(colon.frames.length > compact.frames.length,
    'the observed colon-directed ACK falls back to data framing and takes longer');
});

test('every built frame reassembles into the original message', () => {
  const text = 'KN4CRD MSG HELLO FROM POTACAT';
  const { frames } = V.buildMessageFrames({
    mycall: 'K3SBP', mygrid: 'FN20', text,
  });
  let assembled = '';
  for (const f of frames) {
    const d = V.interpretFrame(f.frame, f.bits, 0);
    assert.notStrictEqual(d.frameType, V.FrameType.FrameUnknown,
      'frame must interpret: ' + f.frame);
    assembled += d.message;
  }
  // The directed frame renders "K3SBP: KN4CRD MSG " and the data frames
  // follow with the message text + checksum. The original text must be
  // recoverable from the rendering.
  assert.ok(assembled.includes('KN4CRD MSG'), assembled);
  assert.ok(assembled.includes('HELLO FROM POTACAT'), assembled);
});

test('a /P mycall is NOT compound — the portable flag carries it', () => {
  // The base callsign pattern grew (?<portable>[/][P])? — so /P calls pack
  // into a single standard directed frame with the portable bit set, and
  // the compound-frame pair is NOT used. (Upstream's CASE 1 comment shows
  // "KN4CRD/P", but its own pattern outgrew the example.)
  const { frames } = V.buildMessageFrames({
    mycall: 'K3SBP/P', mygrid: 'FN20', text: 'KN4CRD ACK',
  });
  assert.strictEqual(frames.length, 1);
  const d = V.interpretFrame(frames[0].frame, frames[0].bits, 0);
  assert.strictEqual(d.frameType, V.FrameType.FrameDirected);
  assert.strictEqual(d.message, 'K3SBP/P: KN4CRD ACK ');
});

test('a genuinely compound mycall sends the compound-frame pair', () => {
  assert.ok(V.isCompoundCallsign('K3SBP/QRP'), 'premise: /QRP is compound');
  const { frames } = V.buildMessageFrames({
    mycall: 'K3SBP/QRP', mygrid: 'FN20', text: 'KN4CRD ACK',
  });
  // CASE 1: standard compound frame first, then compound directed
  assert.strictEqual(frames.length, 2);
  const first = V.interpretFrame(frames[0].frame, 0, 0);
  assert.strictEqual(first.frameType, V.FrameType.FrameCompound);
  assert.strictEqual(first.compound, 'K3SBP/QRP');
  const second = V.interpretFrame(frames[1].frame, 0, 0);
  assert.strictEqual(second.frameType, V.FrameType.FrameCompoundDirected);
});

test('buffered commands get a checksum appended to their data', () => {
  const { frames } = V.buildMessageFrames({
    mycall: 'K3SBP', mygrid: 'FN20', text: 'KN4CRD MSG HI',
  });
  let data = '';
  for (const f of frames.slice(1)) {
    data += V.interpretFrame(f.frame, f.bits, 0).message;
  }
  // 16-bit checksum = 3 chars after the message
  assert.ok(/HI .{3}/.test(data) || data.includes('HI'), data);
  const m = data.match(/^(.*) (.{3})\s*$/);
  assert.ok(m, 'expected trailing checksum in: ' + JSON.stringify(data));
  assert.ok(V.checksum16Valid(m[2], m[1]), 'checksum must validate');
});

// ── through the real modem ───────────────────────────────────────────────────

test('a varicode frame survives the actual JS8 modem (encode->decode)', function () {
  let addon;
  try {
    addon = require('../lib/js8_native/build/Release/js8_native.node');
  } catch (e) {
    console.log('       (js8_native not built — skipping modem integration)');
    return;
  }
  const { frame } = V.packHeartbeatMessage('HB FN20', 'K3SBP');
  const enc = addon.encode({ frame, type: 3, submode: 0, freq: 1500, sampleRate: 12000 });
  assert.strictEqual(enc.tones.length, 79);

  addon.reset();
  const period = 15 * 12000;
  const buf = new Float32Array(period);
  const delay = 6000;
  for (let i = 0; i < enc.audio.length; i++) buf[delay + i] = enc.audio[i] * 0.5;
  for (let i = 0; i < buf.length; i++) buf[i] += (Math.random() - 0.5) * 0.02;

  let decodes = [];
  const CHUNK = 3000;
  for (let off = 0; off < buf.length; off += CHUNK) {
    addon.appendAudio(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
    const r = addon.decode({ submodes: 1, nfa: 500, nfb: 2700, nfqso: 1500, utc: 0 });
    decodes = decodes.concat(r.decodes);
  }
  assert.ok(decodes.length > 0, 'the modem must decode the frame');
  assert.strictEqual(decodes[0].text, frame, 'frame text must survive');
  assert.strictEqual(decodes[0].type, 3, 'itype must survive');

  const d = V.interpretFrame(decodes[0].text, decodes[0].type, decodes[0].mode);
  assert.strictEqual(d.message, 'K3SBP: @HB HEARTBEAT FN20 ');
  assert.ok(d.isFirst && d.isLast);
});

console.log(`\nJS8 varicode: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
