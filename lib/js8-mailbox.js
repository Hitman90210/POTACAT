// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8 mailbox — receive-only v1 of store-and-forward (docs/js8-store-forward-
// spec.md). Holds messages left FOR THIS STATION over the air ("K3SBP MSG
// text" / "MSG TO:K3SBP text") so mail survives restarts and reaches the
// phone. Serving QUERY MSGS / relay are later steps — nothing here transmits.
'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_HELD = 200;

class Js8Mailbox {
  constructor({ ttlMs } = {}) {
    this.ttlMs = ttlMs || DEFAULT_TTL_MS;
    this.messages = []; // { id, from, to, text, checksum, receivedAt, readAt }
  }

  load(json) {
    try {
      const arr = Array.isArray(json) ? json : JSON.parse(json || '[]');
      this.messages = arr.filter((m) => m && m.id && m.text);
    } catch { this.messages = []; }
    this.expire();
  }
  toJSON() { return this.messages; }

  /** Store one piece of mail. Dedupes by content checksum (a message heard
   *  twice — or via two relays — is ONE message). Returns the stored row, or
   *  null when it was a duplicate/empty. */
  add({ from, to, text }) {
    const body = String(text || '').trim();
    const src = String(from || '').toUpperCase();
    if (!body || !src) return null;
    const checksum = crypto.createHash('sha1').update(src + '|' + body).digest('hex').slice(0, 12);
    if (this.messages.some((m) => m.checksum === checksum)) return null;
    const row = {
      id: checksum.slice(0, 6).toUpperCase(),
      from: src, to: String(to || '').toUpperCase(),
      text: body, checksum, receivedAt: Date.now(), readAt: 0, deliveredAt: 0,
    };
    // Chronological (push) so same-millisecond arrivals keep their order —
    // undeliveredFor's stable sort then serves genuinely oldest-first.
    this.messages.push(row);
    if (this.messages.length > MAX_HELD) this.messages.splice(0, this.messages.length - MAX_HELD);
    return row;
  }

  expire(now = Date.now()) {
    this.messages = this.messages.filter((m) => now - m.receivedAt < this.ttlMs);
  }
  get unread() { return this.messages.filter((m) => !m.readAt).length; }
  markRead(id) {
    const m = this.messages.find((x) => x.id === id);
    if (m && !m.readAt) m.readAt = Date.now();
    return !!m;
  }
  markAllRead() { const t = Date.now(); this.messages.forEach((m) => { if (!m.readAt) m.readAt = t; }); }

  // ── mail-drop role (steps 2-3): mail we hold FOR OTHER STATIONS ────────────
  /** Undelivered mail held for `call`, oldest first. */
  undeliveredFor(call) {
    const c = String(call || '').toUpperCase();
    return this.messages.filter((m) => m.to === c && !m.deliveredAt)
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }
  byId(id) { return this.messages.find((m) => m.id === String(id || '').toUpperCase()) || null; }
  markDelivered(id) {
    const m = this.byId(id);
    if (m && !m.deliveredAt) m.deliveredAt = Date.now();
    return !!m;
  }
  /** Distinct calls (other than `except`) we hold undelivered mail for. */
  holdingFor(except) {
    const ex = String(except || '').toUpperCase();
    return [...new Set(this.messages.filter((m) => !m.deliveredAt && m.to && m.to !== ex).map((m) => m.to))];
  }
}

/** Parse a directed text addressed to us into mail, or null. Two forms:
 *  "MSG <text>" (mail left directly) and "MSG TO:<CALL> <text>" when CALL is
 *  us (someone explicitly labeling the recipient). MSG TO: someone ELSE is a
 *  relay request — a later, transmitting step; v1 ignores it. */
function parseMailFor(myCall, text) {
  const me = String(myCall || '').toUpperCase();
  const t = String(text || '').trim();
  let m = /^MSG\s+TO:\s*([A-Z0-9/]+)\s+(.+)$/is.exec(t);
  if (m) return m[1].toUpperCase() === me ? { text: m[2].trim() } : null;
  m = /^MSG\s+(.+)$/is.exec(t);
  return m ? { text: m[1].trim() } : null;
}

module.exports = { Js8Mailbox, parseMailFor, DEFAULT_TTL_MS, MAX_HELD };
