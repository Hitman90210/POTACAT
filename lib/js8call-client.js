// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JS8Call TCP API client.
//
// POTACAT bridges JS8Call rather than decoding JS8 itself: JS8Call is GPLv3,
// and a separate process spoken to over a socket is mere aggregation, where
// linking or porting its code would relicense POTACAT (same posture as wsprd
// and Mercury). This is the socket.
//
// Wire format: newline-delimited JSON, one object per line, both directions.
//     {"type":"RX.DIRECTED","value":"KN4CRD: K3SBP HELLO","params":{...}}
// The client is deliberately incurious about `type` — it re-emits every message
// verbatim as 'message' and only interprets the handful it must act on. JS8Call
// forks (the installed build here is "JS8Call-improved" 2.4.0) and versions
// differ in which events they send, so an unknown type must be inert, not an
// error.
//
// Resilience is modelled on MercuryClient / DxClusterClient, and the reasons
// are the same hard-won ones: a stale-socket guard so a late callback from a
// replaced socket can't corrupt live state, a `_wantDisconnect` intent flag so
// an operator disconnect can't be undone by a queued reconnect, exponential
// backoff so a closed API doesn't hammer localhost, and a liveness watchdog
// because a half-open TCP socket looks identical to a quiet band.

'use strict';

const net = require('net');
const EventEmitter = require('events');

const DEFAULT_PORT = 2442;
const DEFAULT_HOST = '127.0.0.1';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_JITTER = 0.25;

// JS8Call emits traffic continuously on a live band but a quiet band is
// legitimately silent, so silence alone can't mean "dead". It does answer
// STATION.GET_STATUS, so the watchdog probes rather than assumes: ping at
// PROBE_MS of silence, declare the socket dead PROBE_MS later if nothing
// comes back. Half-open TCP (suspend/resume, a killed JS8Call that left the
// port in FIN_WAIT) is otherwise indistinguishable from an empty 20m.
const PROBE_MS = 60000;

// A single JSON line should never be enormous. RX.GET_BAND_ACTIVITY replies can
// be a few hundred KB on a busy band, so this is generous — it exists only to
// stop an unterminated stream growing without bound.
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Parse one API line. Pure — this is the test surface.
 * Returns null for blank lines and anything unparseable, because a fork that
 * prints a banner or a stray log line must not kill the connection.
 * @returns {{type:string, value:string, params:object}|null}
 */
function parseJs8Message(line) {
  const s = String(line || '').trim();
  if (!s || s[0] !== '{') return null;
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;
  return {
    type: obj.type,
    value: typeof obj.value === 'string' ? obj.value : '',
    params: (obj.params && typeof obj.params === 'object') ? obj.params : {},
  };
}

/**
 * Does this message mean JS8Call is transmitting? Pure so the rule is visible
 * and testable rather than buried in a socket handler.
 *
 * Two independent signals, because which one a build sends is version- and
 * fork-dependent and getting this wrong is the expensive failure: if POTACAT
 * misses a key-down it can transmit on top, and on a Flex that re-points
 * `tx=1` and puts JS8Call's audio out on POTACAT's slice.
 *   - RIG.PTT           — explicit, params.PTT truthy
 *   - TX.FRAME / TX.SENDING — a frame is going out now
 * Returns true/false for a TX-state message, or null when the message says
 * nothing about TX (the common case).
 */
function txStateFromMessage(msg) {
  if (!msg) return null;
  const t = String(msg.type || '').toUpperCase();
  if (t === 'RIG.PTT') {
    const p = msg.params || {};
    const v = p.PTT !== undefined ? p.PTT : p.VALUE;
    return truthy(v);
  }
  if (t === 'TX.FRAME' || t === 'TX.SENDING') return true;
  // JS8Call reports idle via STATION.STATUS after a transmission ends on some
  // builds; treat an explicit false there as key-up but never infer key-down
  // from its absence.
  if (t === 'STATION.STATUS') {
    const p = msg.params || {};
    if (p.PTT !== undefined) return truthy(p.PTT);
    if (p.TRANSMITTING !== undefined) return truthy(p.TRANSMITTING);
  }
  return null;
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

/** Was this directed at us? Used to split "traffic" from "for you". */
function isDirectedTo(msg, myCall) {
  if (!msg || !myCall) return false;
  const to = String((msg.params || {}).TO || '').toUpperCase();
  return !!to && to === String(myCall).toUpperCase();
}

class Js8CallClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this._sock = null;
    this._buf = '';
    this._target = { host: DEFAULT_HOST, port: DEFAULT_PORT };
    this._wantDisconnect = false;   // operator intent — survives socket churn
    this._retryMs = RECONNECT_MIN_MS;
    this._reconnectTimer = null;
    this._probeTimer = null;
    this._deadTimer = null;
    this._lastRxMs = 0;
    this._tx = false;               // last known JS8Call TX state
  }

  connect({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
    this._wantDisconnect = false;
    this._target = { host, port };
    this._open();
  }

  _open() {
    this._clearReconnect();
    const sock = new net.Socket();
    this._sock = sock;
    this._buf = '';
    sock.setNoDelay(true);

    sock.on('connect', () => {
      if (this._sock !== sock) return;          // a newer socket already won
      this.connected = true;
      this._retryMs = RECONNECT_MIN_MS;
      this._lastRxMs = Date.now();
      this._armProbe();
      this.emit('status', { connected: true, host: this._target.host, port: this._target.port });
    });

    sock.on('data', (chunk) => {
      if (this._sock !== sock) return;
      this._lastRxMs = Date.now();
      this._clearDeadTimer();                    // anything at all proves it's alive
      this._armProbe();
      this._onData(chunk);
    });

    sock.on('error', (err) => {
      if (this._sock !== sock) return;
      // ECONNREFUSED is the normal shape of "JS8Call isn't running yet" or "its
      // API checkbox is off" — the caller turns that into an explanation, so
      // don't editorialise here.
      this.emit('log', `${this._target.host}:${this._target.port}: ${(err && err.message) || err}`);
    });

    sock.on('close', () => {
      if (this._sock !== sock) return;
      this._handleDrop();
    });

    try {
      sock.connect(this._target.port, this._target.host);
    } catch (err) {
      this.emit('log', `connect failed: ${(err && err.message) || err}`);
      this._handleDrop();
    }
  }

  _handleDrop() {
    const was = this.connected;
    this.connected = false;
    this._clearProbe();
    this._clearDeadTimer();
    // A drop while JS8Call was keyed must not leave POTACAT believing the radio
    // is still held — that would deadlock its own TX until a restart.
    if (this._tx) { this._tx = false; this.emit('tx', false); }
    if (was) this.emit('status', { connected: false, host: this._target.host, port: this._target.port });
    if (this._wantDisconnect) return;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this._clearReconnect();
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
    const wait = Math.round(this._retryMs * jitter);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wantDisconnect) return;
      this._open();
    }, wait);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
    this._retryMs = Math.min(this._retryMs * 2, RECONNECT_MAX_MS);
  }

  // --- liveness -------------------------------------------------------------

  _armProbe() {
    this._clearProbe();
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      if (!this.connected) return;
      // Ask something harmless and cheap. If the socket is half-open this write
      // succeeds locally and the reply never lands, which the dead timer catches.
      this.send({ type: 'STATION.GET_STATUS' });
      this._clearDeadTimer();
      this._deadTimer = setTimeout(() => {
        this._deadTimer = null;
        if (!this.connected) return;
        this.emit('log', `no reply to a status probe in ${PROBE_MS / 1000}s — treating the API socket as dead`);
        this._destroySocket();
      }, PROBE_MS);
      if (this._deadTimer.unref) this._deadTimer.unref();
    }, PROBE_MS);
    if (this._probeTimer.unref) this._probeTimer.unref();
  }

  _clearProbe() { if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; } }
  _clearDeadTimer() { if (this._deadTimer) { clearTimeout(this._deadTimer); this._deadTimer = null; } }
  _clearReconnect() { if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; } }

  _destroySocket() {
    const sock = this._sock;
    if (!sock) return;
    try { sock.destroy(); } catch { /* already gone */ }
    // 'close' fires and _handleDrop takes it from here.
  }

  // --- ingress --------------------------------------------------------------

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    if (this._buf.length > MAX_LINE_BYTES) {
      // Desync or a peer that never sends newlines. Dropping the buffer loses a
      // message; growing it without bound loses the process.
      this.emit('log', `API line exceeded ${MAX_LINE_BYTES} bytes — buffer reset`);
      this._buf = '';
      return;
    }
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    const msg = parseJs8Message(line);
    if (!msg) return;                            // banner/garbage — inert by design

    // TX state first: it is the one thing with a safety consequence, and it
    // must be emitted even if a listener for 'message' throws.
    const tx = txStateFromMessage(msg);
    if (tx !== null && tx !== this._tx) {
      this._tx = tx;
      this.emit('tx', tx);
    }

    this.emit('message', msg);
  }

  // --- egress ---------------------------------------------------------------

  /** Send one API command. No-op when not connected — callers shouldn't have
   *  to guard, and a dropped command is better than a throw in a timer. */
  send({ type, value = '', params = {} } = {}) {
    if (!this.connected || !this._sock || !type) return false;
    try {
      this._sock.write(JSON.stringify({ type, value, params }) + '\n');
      return true;
    } catch (err) {
      this.emit('log', `send failed: ${(err && err.message) || err}`);
      return false;
    }
  }

  /** Ask JS8Call who it is and what it's doing — used right after connect so the
   *  UI has a station identity before any traffic arrives. */
  requestStationInfo() {
    this.send({ type: 'STATION.GET_CALLSIGN' });
    this.send({ type: 'STATION.GET_GRID' });
    this.send({ type: 'STATION.GET_STATUS' });
  }

  /** Current activity JS8Call has decoded, for populating a freshly opened view. */
  requestActivity() {
    this.send({ type: 'RX.GET_CALL_ACTIVITY' });
    this.send({ type: 'RX.GET_BAND_ACTIVITY' });
  }

  /** Queue a message for transmission. TX is a later phase and gated on
   *  `AcceptTCPRequests`; kept here so the command surface is in one place. */
  sendMessage(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return this.send({ type: 'TX.SEND_MESSAGE', value: t });
  }

  get transmitting() { return this._tx; }

  /** Operator intent: stop, and forget the retry history. */
  disconnect() {
    this._wantDisconnect = true;
    this._clearReconnect();
    this._clearProbe();
    this._clearDeadTimer();
    this._retryMs = RECONNECT_MIN_MS;
    const sock = this._sock;
    this._sock = null;
    this._buf = '';
    if (this._tx) { this._tx = false; this.emit('tx', false); }
    if (sock) { try { sock.destroy(); } catch { /* already gone */ } }
    if (this.connected) {
      this.connected = false;
      this.emit('status', { connected: false, host: this._target.host, port: this._target.port });
    }
  }
}

module.exports = {
  Js8CallClient,
  parseJs8Message,
  txStateFromMessage,
  isDirectedTo,
  DEFAULT_PORT,
  DEFAULT_HOST,
  PROBE_MS,
  RECONNECT_MIN_MS,
  RECONNECT_MAX_MS,
};
