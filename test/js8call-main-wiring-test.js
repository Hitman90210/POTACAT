#!/usr/bin/env node
'use strict';
/**
 * Static scan of main.js's JS8Call wiring.
 *
 * WHY A STATIC TEST. On 2026-08-06 planJs8Setup/applyJs8Setup gained an `await`
 * (audio-device enumeration) and became async. One caller was not updated:
 *
 *     const r = applyJs8Setup(opts || {});
 *     if (r.ok) { launchJs8Call(); }
 *     return r;
 *
 * `r` was a Promise, so `r.ok` was undefined and the launch silently never ran
 * — and because ipcMain.handle resolves a returned Promise, the renderer still
 * received {ok:true} and reported "Starting JS8Call…". The settings were
 * patched and no JS8Call appeared. Nothing threw, nothing logged, and the
 * success path lied, which is the only failure mode worse than a crash.
 *
 * There is no runtime test for this without an Electron main process and a
 * JS8Call install, so it is checked in the source. Precedent:
 * test/protocol-demux-parity-test.js.
 *
 * Run: node test/js8call-main-wiring-test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/**
 * Comments and string literals blanked to spaces, byte offsets preserved so
 * line numbers still line up with the real file.
 *
 * Not optional: the first version of this test matched `applyJs8Setup()`
 * inside the comment that explains this very bug, and reported the fixed code
 * as broken. A source scanner that reads prose as code produces false alarms
 * until someone deletes it, which is worse than having no scanner.
 */
function blankNonCode(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

const SRC = blankNonCode(RAW);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** Line numbers make a failure actionable instead of a scavenger hunt. */
function lineOf(index) {
  return SRC.slice(0, index).split('\n').length;
}

/** Every call to `name(` that is not its own definition. */
function callSites(name) {
  const out = [];
  const re = new RegExp('\\b' + name + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(SRC))) {
    const before = SRC.slice(Math.max(0, m.index - 40), m.index);
    if (/\b(?:async\s+)?function\s+$/.test(before)) continue;   // the definition
    out.push({ index: m.index, line: lineOf(m.index), before });
  }
  return out;
}

const ASYNC = ['planJs8Setup', 'applyJs8Setup', 'js8AudioLabels'];

test('the functions this guards are in fact async', () => {
  for (const fn of ASYNC) {
    assert.ok(new RegExp('async function ' + fn + '\\b').test(SRC),
      fn + ' is no longer async — delete it from ASYNC or this test guards nothing');
  }
});

test('every call to an async JS8Call function is awaited or returned', () => {
  const bad = [];
  for (const fn of ASYNC) {
    for (const site of callSites(fn)) {
      // Legitimate: `await fn(`, `return fn(`, `=> fn(`, `.then(` chains.
      const ok = /\bawait\s+$/.test(site.before)
        || /\breturn\s+$/.test(site.before)
        || /=>\s*$/.test(site.before);
      if (!ok) bad.push(`main.js:${site.line}  ${fn}() — result used as a plain value`);
    }
  }
  assert.deepStrictEqual(bad, [],
    'a Promise used as an object yields undefined properties, not an error:\n  ' + bad.join('\n  '));
});

test('the apply-setup IPC handler is async', () => {
  const m = RAW.match(/ipcMain\.handle\(\s*'js8call-apply-setup'\s*,\s*(async\s*)?\(/);
  assert.ok(m, "the 'js8call-apply-setup' handler was not found — was it renamed?");
  assert.ok(m[1], 'the handler must be async: it awaits applyJs8Setup before deciding to launch');
});

/** The handler body, by brace matching — `indexOf('});')` stops at the first
 *  `{}` argument inside it, which is `applyJs8Setup(opts || {})`. */
function handlerBody(channel) {
  // Located in RAW (blankNonCode erases the quoted channel name), brace-matched
  // in SRC (whose offsets are identical but whose braces are all real code).
  const at = RAW.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(at > 0, `the '${channel}' handler was not found — was it renamed?`);
  let depth = 0, start = -1;
  for (let i = at; i < SRC.length; i++) {
    if (SRC[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (SRC[i] === '}') { depth--; if (depth === 0) return RAW.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces after ' + channel);
}

test('applying the setup still reaches the launch', () => {
  const handler = handlerBody('js8call-apply-setup');
  assert.ok(/await\s+applyJs8Setup/.test(handler), 'applyJs8Setup must be awaited');
  assert.ok(/launchJs8Call\(\)/.test(handler), 'a successful apply must go on to start JS8Call');
});

test('every exit from launchJs8Call reports itself', () => {
  // "Nothing happened" was indistinguishable from "it started" in the CAT log.
  const start = SRC.indexOf('function launchJs8Call()');
  assert.ok(start > 0, 'launchJs8Call not found');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  const returns = (body.match(/\breturn\s*\{/g) || []).length;
  const logs = (body.match(/sendCatLog\(/g) || []).length;
  assert.ok(logs >= returns - 1,
    `launchJs8Call has ${returns} outcomes but only ${logs} log lines — a silent one is invisible`);
});

// ── the popout's setup gate ─────────────────────────────────────────────────

const POPOUT = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js8call-popout.js'), 'utf8');

test('the DAX prerequisite block yields to the audio bridge', () => {
  // With POTACAT acting as JS8Call's sound card, DAX and SmartSDR CAT are not
  // prerequisites for anything — the audio arrives over the network and the
  // radio is tuned from POTACAT. The blocker returned early regardless, so the
  // screen read "JS8Call needs two SmartSDR helpers running" directly above its
  // own panel headed "Skip DAX entirely", and hid every button that starts
  // JS8Call. The operator had followed the instructions and had nowhere to go
  // (K3SBP 2026-08-08).
  const m = POPOUT.match(/if \(\(?p\.daxDown[^)]*\)?[^{]*\{/);
  assert.ok(m, 'the daxDown/catShimDown branch was not found — has it been renamed?');
  assert.ok(/bridgeOn/.test(m[0]),
    'the DAX blocker must be conditional on the bridge being off: ' + m[0]);
});

test('the bridge state is awaited before the setup branches on it', () => {
  // refreshAudioBridge is async. Read without awaiting, `enabled` is undefined
  // and every branch silently takes the no-bridge path — the same shape as the
  // applyJs8Setup bug this file was written for.
  const start = POPOUT.indexOf('async function refreshSetupInner()');
  assert.ok(start > 0, 'refreshSetupInner not found');
  const body = POPOUT.slice(start, start + 2000);
  assert.ok(/await\s+refreshAudioBridge\(\)/.test(body),
    'refreshSetupInner must await refreshAudioBridge() before branching on it');
});

test('toggling the bridge redraws the setup screen, not just its own panel', () => {
  // Enabling the bridge changes which prerequisites apply, so it changes the
  // heading, the notes and which buttons exist. saveAudioBridge refreshed only
  // the audio panel, so the screen kept the pre-bridge heading and hid every
  // launch button until the operator happened to press Retry — with "Receive
  // audio is flowing" showing two inches below it (K3SBP 2026-08-08).
  const start = POPOUT.indexOf('async function saveAudioBridge(');
  assert.ok(start > 0, 'saveAudioBridge not found');
  const body = POPOUT.slice(start, POPOUT.indexOf('\n  }', start));
  assert.ok(/refreshSetup\(\)/.test(body),
    'saveAudioBridge must refresh the whole setup screen, not only the audio panel');
});

console.log(`\nJS8Call main wiring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
