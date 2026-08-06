#!/usr/bin/env node
'use strict';
/**
 * JS8 traffic → conversations.
 *
 * The behaviour worth protecting here is unread state. JS8Call has none: a
 * message addressed to you scrolls past in the same stream as everyone's
 * heartbeats, and if you were away it is simply gone. Everything below exists
 * to make sure a message for the operator is never silently lost or silently
 * marked read.
 *
 * Run: node test/js8call-threads-test.js
 */

const assert = require('assert');
const { Js8Threads, isHeartbeatText, isGroupTarget, threadIdFor, MAX_THREADS } =
  require('../lib/js8call-threads');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const ME = 'K3SBP';
const mk = (o) => Object.assign({ from: '', to: '', text: '', snr: -10, utc: 1000 }, o);

// ── routing ──────────────────────────────────────────────────────────────────

test('a message to us threads under the sender', () => {
  assert.strictEqual(threadIdFor({ from: 'KC1QKM', to: 'K3SBP' }, ME), 'KC1QKM');
});

test('a message from us threads under the addressee', () => {
  assert.strictEqual(threadIdFor({ from: 'K3SBP', to: 'KC1QKM' }, ME), 'KC1QKM');
});

test('group traffic threads under the group', () => {
  assert.strictEqual(threadIdFor({ from: 'W1AW', to: '@HB' }, ME), '@HB');
  assert.strictEqual(threadIdFor({ from: 'K3SBP', to: '@ALLCALL' }, ME), '@ALLCALL');
});

test("someone else's exchange is not one of our conversations", () => {
  // It still reaches the all-traffic view; it just doesn't invent a thread.
  assert.strictEqual(threadIdFor({ from: 'W1AW', to: 'VE3NRT' }, ME), null);
});

test('routing is case-insensitive and survives a missing call', () => {
  assert.strictEqual(threadIdFor({ from: 'kc1qkm', to: 'k3sbp' }, 'K3SBP'), 'KC1QKM');
  assert.strictEqual(threadIdFor({ from: '', to: '' }, ME), null);
  assert.strictEqual(threadIdFor({ from: 'W1AW', to: 'VE3NRT' }, ''), null);
});

test('isGroupTarget covers @-anything, not just the known list', () => {
  assert.strictEqual(isGroupTarget('@HB'), true);
  assert.strictEqual(isGroupTarget('@POTA'), true, 'unknown groups still group');
  assert.strictEqual(isGroupTarget('K3SBP'), false);
});

// ── heartbeat folding ────────────────────────────────────────────────────────

test('heartbeat shapes are recognised', () => {
  assert.strictEqual(isHeartbeatText('K3SBP: @HB HB FN20'), true);
  assert.strictEqual(isHeartbeatText('W1AW: @HB HEARTBEAT FN31'), true);
  assert.strictEqual(isHeartbeatText('KC1QKM: HB EM79'), true);
  assert.strictEqual(isHeartbeatText('KC1QKM: K3SBP SNR -11'), false);
  assert.strictEqual(isHeartbeatText('KC1QKM: K3SBP HB IS MY HOBBY'), false,
    'HB mid-sentence is not a heartbeat frame');
});

test('heartbeats are counted, not listed', () => {
  const t = new Js8Threads({ myCall: ME });
  t.ingest(mk({ from: 'W1AW', to: '@HB', text: 'W1AW: @HB HEARTBEAT FN31' }));
  t.ingest(mk({ from: 'VE3NRT', to: '@HB', text: 'VE3NRT: @HB HB FN25' }));
  const th = t.thread('@HB');
  assert.strictEqual(th.hbCount, 2);
  assert.strictEqual(th.messages.length, 0, 'the net does not fill the transcript');
});

test('a folded heartbeat never marks a conversation unread', () => {
  const t = new Js8Threads({ myCall: ME });
  const r = t.ingest(mk({ from: 'W1AW', to: 'K3SBP', text: 'W1AW: K3SBP @HB HEARTBEAT' }));
  assert.strictEqual(r.folded, true);
  assert.strictEqual(r.unread, false);
  assert.strictEqual(t.totalUnread, 0);
});

// ── unread: the point of the whole module ────────────────────────────────────

test('a message addressed to us, in a closed conversation, is unread', () => {
  const t = new Js8Threads({ myCall: ME });
  const r = t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'KC1QKM: K3SBP SNR -11' }));
  assert.strictEqual(r.unread, true);
  assert.strictEqual(t.totalUnread, 1);
  assert.strictEqual(t.list()[0].unread, 1);
});

test('unread accumulates while the window is closed', () => {
  const t = new Js8Threads({ myCall: ME });
  for (let i = 0; i < 3; i++) {
    t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'msg ' + i, utc: 1000 + i }));
  }
  assert.strictEqual(t.totalUnread, 3);
});

test('the open conversation is read on arrival, others are not', () => {
  const t = new Js8Threads({ myCall: ME });
  t.setOpen('KC1QKM');
  t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'while watching' }));
  assert.strictEqual(t.totalUnread, 0, 'you are looking straight at it');
  t.ingest(mk({ from: 'W1AW', to: 'K3SBP', text: 'another window' }));
  assert.strictEqual(t.totalUnread, 1, 'a different correspondent still counts');
});

test('our own transmissions are never unread', () => {
  const t = new Js8Threads({ myCall: ME });
  t.ingest(mk({ from: 'K3SBP', to: 'KC1QKM', text: 'K3SBP: KC1QKM 73' }));
  assert.strictEqual(t.totalUnread, 0);
  assert.strictEqual(t.list()[0].lastDir, 'out');
});

test('group net traffic is never unread', () => {
  const t = new Js8Threads({ myCall: ME });
  t.ingest(mk({ from: 'W1AW', to: '@ALLCALL', text: 'W1AW: @ALLCALL ANYONE ON' }));
  assert.strictEqual(t.totalUnread, 0, 'a broadcast is not mail for you');
});

test('opening a conversation clears its badge and only its badge', () => {
  const t = new Js8Threads({ myCall: ME });
  t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'a' }));
  t.ingest(mk({ from: 'W1AW', to: 'K3SBP', text: 'b' }));
  assert.strictEqual(t.totalUnread, 2);
  t.setOpen('KC1QKM');
  assert.strictEqual(t.totalUnread, 1);
  assert.strictEqual(t.thread('W1AW') && t.list().find((x) => x.id === 'W1AW').unread, 1);
});

// ── transcript ───────────────────────────────────────────────────────────────

test('a thread reads in order with direction, snr and time', () => {
  const t = new Js8Threads({ myCall: ME });
  t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'KC1QKM: K3SBP SNR?', snr: -13, utc: 100 }));
  t.ingest(mk({ from: 'K3SBP', to: 'KC1QKM', text: 'K3SBP: KC1QKM SNR -11', utc: 200 }));
  const th = t.thread('KC1QKM');
  assert.deepStrictEqual(th.messages.map((m) => m.dir), ['in', 'out']);
  assert.strictEqual(th.messages[0].snr, -13);
  assert.strictEqual(th.messages[1].utc, 200);
});

test('an absent SNR is null, not zero — zero dB is a real report', () => {
  const t = new Js8Threads({ myCall: ME });
  t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'x', snr: undefined }));
  t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'y', snr: 0 }));
  const m = t.thread('KC1QKM').messages;
  assert.strictEqual(m[0].snr, null);
  assert.strictEqual(m[1].snr, 0);
});

test('recordOutgoing puts our own send in the right thread', () => {
  const t = new Js8Threads({ myCall: ME });
  const r = t.recordOutgoing('KC1QKM: K3SBP NICE — 73', 500);
  assert.strictEqual(r.threadId, 'KC1QKM');
  assert.strictEqual(t.thread('KC1QKM').messages[0].dir, 'out');
});

test('recordOutgoing routes a heartbeat to its group and folds it', () => {
  const t = new Js8Threads({ myCall: ME });
  const r = t.recordOutgoing('@HB HB FN20', 500);
  assert.strictEqual(r.threadId, '@HB');
  assert.strictEqual(r.folded, true);
  assert.strictEqual(t.thread('@HB').hbCount, 1);
});

test('recordOutgoing ignores text with no target', () => {
  const t = new Js8Threads({ myCall: ME });
  assert.strictEqual(t.recordOutgoing('   ').threadId, null);
});

// ── ordering + bounds ────────────────────────────────────────────────────────

test('conversations list most-recent first', () => {
  const t = new Js8Threads({ myCall: ME });
  t.ingest(mk({ from: 'W1AW', to: 'K3SBP', text: 'old', utc: 100 }));
  t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'new', utc: 900 }));
  assert.deepStrictEqual(t.list().map((x) => x.id), ['KC1QKM', 'W1AW']);
});

test('eviction never discards a conversation with unread mail', () => {
  const t = new Js8Threads({ myCall: ME });
  // One old thread with unread, then flood well past the cap with read ones.
  t.ingest(mk({ from: 'PRECIOUS', to: 'K3SBP', text: 'unread!', utc: 1 }));
  for (let i = 0; i < MAX_THREADS + 20; i++) {
    t.ingest(mk({ from: 'K3SBP', to: 'FILLER' + i, text: 'x', utc: 1000 + i }));
  }
  assert.ok(t.list().some((x) => x.id === 'PRECIOUS'), 'unread mail survives the cap');
  assert.strictEqual(t.totalUnread, 1);
});

test('setMyCall re-points routing for a callsign learned after connect', () => {
  // STATION.GET_CALLSIGN answers after the socket opens, so early frames can
  // arrive before we know who we are.
  const t = new Js8Threads({});
  assert.strictEqual(t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'a' })).threadId, null);
  t.setMyCall('K3SBP');
  assert.strictEqual(t.ingest(mk({ from: 'KC1QKM', to: 'K3SBP', text: 'b' })).threadId, 'KC1QKM');
});

console.log(`\nJS8Call threads: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
