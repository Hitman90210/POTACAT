#!/usr/bin/env node
'use strict';
// JS8 mailbox (receive-only) + SMS/email builders. Run: node test/js8-mailbox-test.js
const assert = require('assert');
const { Js8Mailbox, parseMailFor } = require('../lib/js8-mailbox');
const { buildSmsMessage, buildEmailMessage, padAddressee } = require('../lib/aprs-is');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('mail parses from both on-air forms, addressed to us only', () => {
  assert.deepStrictEqual(parseMailFor('K3SBP', 'MSG call me on 40m'), { text: 'call me on 40m' });
  assert.deepStrictEqual(parseMailFor('K3SBP', 'MSG TO:K3SBP see you at 2300z'), { text: 'see you at 2300z' });
  assert.strictEqual(parseMailFor('K3SBP', 'MSG TO:W1AW not ours'), null, 'relay requests are a later, transmitting step');
  assert.strictEqual(parseMailFor('K3SBP', 'SNR -12'), null);
});

test('the store dedupes by content and counts unread', () => {
  const box = new Js8Mailbox();
  const a = box.add({ from: 'W1AW', to: 'K3SBP', text: 'hello' });
  assert.ok(a && a.id);
  assert.strictEqual(box.add({ from: 'W1AW', to: 'K3SBP', text: 'hello' }), null, 'heard twice = one message');
  box.add({ from: 'W1AW', to: 'K3SBP', text: 'second' });
  assert.strictEqual(box.unread, 2);
  box.markRead(a.id);
  assert.strictEqual(box.unread, 1);
});

test('expiry drops old mail; load round-trips', () => {
  const box = new Js8Mailbox({ ttlMs: 1000 });
  box.add({ from: 'W1AW', to: 'K3SBP', text: 'old' });
  box.messages[0].receivedAt = Date.now() - 5000;
  box.expire();
  assert.strictEqual(box.messages.length, 0);
  const b2 = new Js8Mailbox();
  b2.add({ from: 'W1AW', to: 'K3SBP', text: 'kept' });
  const b3 = new Js8Mailbox();
  b3.load(JSON.stringify(b2.toJSON()));
  assert.strictEqual(b3.messages.length, 1);
});

test('SMS/email builders pin the silent-failure details', () => {
  assert.strictEqual(padAddressee('SMSGTE').length, 9, 'exactly 9, space-padded');
  assert.strictEqual(buildSmsMessage('SMSGTE', '(555) 123-4567', 'hi', 1), ':SMSGTE   :@5551234567 hi{01');
  assert.strictEqual(buildEmailMessage('EMAIL-2', 'a@b.co', 'yo', 12), ':EMAIL-2  :a@b.co yo{12');
  assert.strictEqual(buildSmsMessage('SMSGTE', '123', 'hi', 1), null, 'too-short number refused');
  assert.strictEqual(buildEmailMessage('EMAIL-2', 'not-an-email', 'x', 1), null);
  assert.ok(!buildSmsMessage('SMSGTE', '5551234567', 'a{b}c', 1).includes('}'), 'braces stripped from body (they delimit the seq)');
});

const { Js8MailGovernor } = require('../lib/js8-mail-governor');

test('mail-drop: undelivered per call, delivery stamps, holding list', () => {
  const box = new Js8Mailbox();
  const a = box.add({ from: 'W1AW', to: 'K1ABC', text: 'first' });
  box.add({ from: 'W1AW', to: 'K1ABC', text: 'second' });
  box.add({ from: 'W1AW', to: 'N0DE', text: 'other' });
  assert.strictEqual(box.undeliveredFor('K1ABC').length, 2);
  assert.strictEqual(box.undeliveredFor('K1ABC')[0].text, 'first', 'oldest first');
  assert.ok(box.markDelivered(a.id));
  assert.strictEqual(box.undeliveredFor('K1ABC').length, 1);
  assert.deepStrictEqual(box.holdingFor('').sort(), ['K1ABC', 'N0DE']);
  assert.deepStrictEqual(box.holdingFor('N0DE'), ['K1ABC'], 'own mail excluded');
});

test('governor: budget + per-call caps, rolling window', () => {
  const g = new Js8MailGovernor({ windowMs: 1000, budgetSec: 30, maxPerCall: 2 });
  const t0 = 1000000;
  assert.strictEqual(g.refusal('W1AW', 15, t0), '');
  g.record('W1AW', 15, t0);
  assert.ok(/budget spent/.test(g.refusal('W1AW', 16, t0)), 'over budget refused');
  g.record('W1AW', 10, t0);
  assert.ok(/already served/.test(g.refusal('W1AW', 1, t0)), 'per-call cap refused');
  assert.strictEqual(g.refusal('K1ABC', 5, t0), '', 'other calls still fine');
  assert.strictEqual(g.refusal('W1AW', 15, t0 + 2000), '', 'window rolls off');
});

console.log(`\nJS8 mailbox: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
