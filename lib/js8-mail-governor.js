// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Duty-cycle governor for JS8 mail service (store-and-forward steps 2-4).
// Every automatic mail transmission passes through ONE budget: a rolling
// window of transmit seconds. Its refusals ARE the feature — an unattended
// bug must not be able to jam a band. Pure; main owns the clock.
'use strict';

const DEFAULTS = {
  windowMs: 3600 * 1000,   // rolling hour
  budgetSec: 120,          // max automatic-mail TX seconds per window
  maxPerCall: 4,           // max automatic transmissions to one station per window
};

class Js8MailGovernor {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || DEFAULTS.windowMs;
    this.budgetSec = opts.budgetSec || DEFAULTS.budgetSec;
    this.maxPerCall = opts.maxPerCall || DEFAULTS.maxPerCall;
    this._spends = [];   // { at, sec, call }
  }
  _prune(now) { this._spends = this._spends.filter((s) => now - s.at < this.windowMs); }
  usedSec(now = Date.now()) { this._prune(now); return this._spends.reduce((a, s) => a + s.sec, 0); }
  /** May we start an automatic transmission of ~estSec to `call` right now?
   *  Returns '' when allowed, else a human-readable refusal. */
  refusal(call, estSec, now = Date.now()) {
    this._prune(now);
    const used = this.usedSec(now);
    if (used + estSec > this.budgetSec) {
      return `mail TX budget spent (${Math.round(used)}s of ${this.budgetSec}s this hour)`;
    }
    const per = this._spends.filter((s) => s.call === call).length;
    if (per >= this.maxPerCall) return `already served ${call} ${per}x this hour`;
    return '';
  }
  record(call, sec, now = Date.now()) { this._spends.push({ at: now, sec, call }); this._prune(now); }
}

module.exports = { Js8MailGovernor, DEFAULTS };
