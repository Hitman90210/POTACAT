#!/usr/bin/env node
'use strict';
// FreeDV Reporter crash guards (2026-08-15: an unreachable qso.freedv.org
// took down the whole app via an unheard 'error' event on an orphaned
// client). Run: node test/freedv-reporter-test.js
const assert = require('assert');
const { FreedvReporterClient } = require('../lib/freedv-reporter');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('_emitError with zero listeners must not throw (process-killer guard)', () => {
  const c = new FreedvReporterClient();
  c._emitError(new Error('connect ETIMEDOUT')); // would crash the process pre-fix
});

test('_emitError reaches an attached listener', () => {
  const c = new FreedvReporterClient();
  let got = null;
  c.on('error', (e) => { got = e; });
  c._emitError(new Error('boom'));
  assert.ok(got && got.message === 'boom');
});

test('disconnect neuters the stale socket so late errors are swallowed', () => {
  const c = new FreedvReporterClient();
  // Stand in for a CONNECTING ws: capture handlers like the real one would.
  const { EventEmitter } = require('events');
  const fakeWs = new EventEmitter();
  fakeWs.close = () => {};
  c._ws = fakeWs;
  fakeWs.on('error', (e) => c._emitError(e)); // as wired in _doConnect
  c.disconnect();
  c.removeAllListeners(); // consumer teardown, as main.js does
  // The in-flight TCP attempt times out AFTER teardown — must be inert.
  fakeWs.emit('error', new Error('connect ETIMEDOUT (late)'));
  assert.strictEqual(c._ws, null);
});

console.log(`\nFreeDV Reporter: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
