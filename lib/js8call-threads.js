// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8 traffic → conversations.
//
// JS8Call presents its traffic as a decoder log sorted by audio offset, which
// is what the modem did rather than what the operator is doing. JS8 is
// asynchronous messaging, so POTACAT groups the same frames by correspondent
// and keeps an unread count — the one thing a log cannot give you, and the
// reason a message that arrives while you are away is currently just gone.
//
// Pure: no sockets, no Electron, no timers. main.js owns one instance and feeds
// it parsed API messages; the popout renders what it returns. State lives here
// (not in the renderer) so counts keep accumulating while the window is closed.

'use strict';

const MAX_THREADS = 60;
const MAX_MESSAGES = 250;

/** JS8Call's group targets. A message to one of these is net traffic, not a
 *  private exchange, so it gets its own row instead of inventing a "person". */
const GROUPS = ['@HB', '@ALLCALL', '@DX', '@GROUP', '@QSO', '@NET', '@CQ'];

/** Heartbeat / keepalive shapes, folded out of a conversation so the net stops
 *  shouting over the messages. Everything still reaches the all-traffic view —
 *  this hides nothing, it only declines to interleave it. */
function isHeartbeatText(text) {
  const t = String(text || '').toUpperCase();
  return /@HB\b/.test(t) || /\bHEARTBEAT\b/.test(t) || /(^|:\s*)HB\b/.test(t);
}

function isGroupTarget(to) {
  const t = String(to || '').toUpperCase();
  return t.startsWith('@') || GROUPS.includes(t);
}

const up = (s) => String(s || '').trim().toUpperCase();

/**
 * Which conversation does this belong to, from OUR point of view?
 *   - addressed to us      → the sender
 *   - sent by us           → the addressee
 *   - to a group           → that group
 *   - anyone else's        → null (all-traffic only; it is not our conversation)
 */
function threadIdFor({ from, to }, myCall) {
  const f = up(from), t = up(to), me = up(myCall);
  if (!t && !f) return null;
  if (isGroupTarget(t)) return t;
  if (me && t === me) return f || null;
  if (me && f === me) return t || null;
  return null;
}

class Js8Threads {
  constructor({ myCall = '' } = {}) {
    this.myCall = up(myCall);
    this._threads = new Map();   // id -> thread
    this._openId = null;         // conversation currently on screen
  }

  setMyCall(call) { this.myCall = up(call); }

  /** The conversation the operator is looking at. Messages arriving here are
   *  read on arrival, which is why this has to be told, not guessed. */
  setOpen(id) {
    this._openId = id ? up(id) : null;
    if (this._openId) this.markRead(this._openId);
  }

  _thread(id) {
    let th = this._threads.get(id);
    if (!th) {
      th = {
        id, call: id, isGroup: isGroupTarget(id),
        unread: 0, lastUtc: 0, lastText: '', lastDir: 'in',
        hbCount: 0, messages: [],
      };
      this._threads.set(id, th);
      // Oldest-first eviction, but never drop a conversation with unread mail —
      // losing an unheeded message is precisely the failure this exists to fix.
      while (this._threads.size > MAX_THREADS) {
        let victim = null;
        for (const t of this._threads.values()) {
          if (t.unread > 0) continue;
          if (!victim || t.lastUtc < victim.lastUtc) victim = t;
        }
        if (!victim) break;
        this._threads.delete(victim.id);
      }
    }
    return th;
  }

  /**
   * Fold one decoded directed message in.
   * @returns {{threadId:string|null, unread:boolean, folded:boolean}}
   */
  ingest({ from, to, text, snr, offset, utc, dir }) {
    const id = threadIdFor({ from, to }, this.myCall);
    if (!id) return { threadId: null, unread: false, folded: false };

    const th = this._thread(id);
    const when = Number(utc) || Date.now();
    const outgoing = dir === 'out' || (this.myCall && up(from) === this.myCall);
    const hb = isHeartbeatText(text);

    if (hb) {
      // Counted, not listed. The count is what makes "the net is alive" legible
      // without it costing a screenful.
      th.hbCount++;
      th.lastUtc = Math.max(th.lastUtc, when);
      return { threadId: id, unread: false, folded: true };
    }

    th.messages.push({
      dir: outgoing ? 'out' : 'in',
      from: up(from), to: up(to),
      text: String(text || ''),
      snr: (snr === undefined || snr === null || snr === '') ? null : Number(snr),
      offset: offset == null ? null : Number(offset),
      utc: when,
    });
    while (th.messages.length > MAX_MESSAGES) th.messages.shift();

    th.lastUtc = Math.max(th.lastUtc, when);
    th.lastText = String(text || '');
    th.lastDir = outgoing ? 'out' : 'in';

    // Unread is for mail addressed to US, that we are not currently looking at.
    // Our own sends and group net traffic never count.
    const addressedToMe = !!this.myCall && up(to) === this.myCall;
    const isOpen = this._openId === id;
    const unread = addressedToMe && !outgoing && !isOpen;
    if (unread) th.unread++;
    return { threadId: id, unread, folded: false };
  }

  /** Something POTACAT queued for transmission, shown before the radio confirms
   *  it — so the operator sees their own message land in the thread. */
  recordOutgoing(text, utc) {
    const raw = String(text || '').trim();
    if (!raw) return { threadId: null };
    // "KC1QKM: K3SBP HELLO" or "@HB HB FN20" — the first token is the target.
    const m = raw.match(/^([@A-Z0-9/]+)[:\s]/i);
    const to = m ? up(m[1]) : '';
    if (!to) return { threadId: null };
    return this.ingest({
      from: this.myCall, to, text: raw, utc: utc || Date.now(), dir: 'out',
    });
  }

  markRead(id) {
    const th = this._threads.get(up(id));
    if (th) th.unread = 0;
  }

  /** Conversation rows, most recent first. Unread float nowhere special —
   *  recency is the order operators expect, and the badge carries the urgency. */
  list() {
    return [...this._threads.values()]
      .sort((a, b) => b.lastUtc - a.lastUtc)
      .map((t) => ({
        id: t.id, call: t.call, isGroup: t.isGroup, unread: t.unread,
        lastUtc: t.lastUtc, lastText: t.lastText, lastDir: t.lastDir,
        hbCount: t.hbCount, count: t.messages.length,
      }));
  }

  thread(id) {
    const th = this._threads.get(up(id));
    if (!th) return null;
    return {
      id: th.id, call: th.call, isGroup: th.isGroup,
      hbCount: th.hbCount, messages: th.messages.slice(),
    };
  }

  get totalUnread() {
    let n = 0;
    for (const t of this._threads.values()) n += t.unread;
    return n;
  }

  clear() { this._threads.clear(); this._openId = null; }
}

module.exports = { Js8Threads, isHeartbeatText, isGroupTarget, threadIdFor, GROUPS, MAX_THREADS, MAX_MESSAGES };
