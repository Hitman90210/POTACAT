// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS-IS uplink client + pure packet builders for the JS8 → APRS gateway.
//
// POTACAT's gateway role is RECEIVE-ONLY on RF: it decodes @APRSIS directed
// messages other stations transmit over JS8 and forwards ("gates") them to
// the APRS-IS internet backbone under the operator's callsign. Nothing here
// ever keys a transmitter — the risk surface is an internet socket, which is
// why the feature can default to a persisted setting rather than the
// session-only posture automatic TX requires.
//
// Why this matters: JS8's APRS features (SMS/email out, position reports)
// have a SUPPLY problem — few RF→IS gateways listen at any moment, so
// packets vanish silently. Every POTACAT home station that opts in makes the
// feature work better for everyone, including non-POTACAT users.
//
// Wire format notes (aprs-is.net):
//  - login line: "user CALL pass PASSCODE vers NAME VERSION"
//  - a verified login is required to inject packets; the passcode is the
//    standard public algorithm every APRS client ships.
//  - gated packet: SRC>APZJS8,TCPIP*,qAR,GATE:payload  (qAR = gated from RF
//    by a verified station; APZJS8 = experimental tocall for JS8).
//  - server lines starting with '#' are comments/keepalives.

'use strict';

const net = require('net');
const { EventEmitter } = require('events');

/** The standard APRS-IS passcode for a callsign (SSID stripped). Public
 *  algorithm — every APRS client embeds it. */
function aprsPasscode(callsign) {
  const call = String(callsign || '').toUpperCase().split('-')[0].trim();
  if (!call) return -1;
  let hash = 0x73e2;
  for (let i = 0; i < call.length; i += 2) {
    hash ^= call.charCodeAt(i) << 8;
    if (i + 1 < call.length) hash ^= call.charCodeAt(i + 1);
  }
  return hash & 0x7fff;
}

/** A gated third-party packet: the RF sender stays the source, our call
 *  appears in the qAR path (we vouch we heard it on RF). */
function buildGatePacket(srcCall, gateCall, payload) {
  const src = String(srcCall || '').toUpperCase().trim();
  const gate = String(gateCall || '').toUpperCase().trim();
  const body = String(payload || '').replace(/[\r\n]/g, ' ').trim();
  if (!src || !gate || !body) return null;
  return `${src}>APZJS8,TCPIP*,qAR,${gate}:${body}`;
}

/** Maidenhead (4 or 6 chars) → APRS uncompressed lat/lon strings, centered
 *  on the (sub)square. Returns null on a malformed grid. */
function gridToAprsLatLon(grid) {
  const g = String(grid || '').toUpperCase().trim();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + parseInt(g[2], 10) * 2;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90 + parseInt(g[3], 10);
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24) + (1 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24) + (0.5 / 24);
  } else {
    lon += 1; lat += 0.5; // center of the square
  }
  const fmt = (v, isLat) => {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = (a - deg) * 60;
    const degStr = String(deg).padStart(isLat ? 2 : 3, '0');
    const minStr = min.toFixed(2).padStart(5, '0');
    return `${degStr}${minStr}${hemi}`;
  };
  return { lat: fmt(lat, true), lon: fmt(lon, false) };
}

/** A position report gated on behalf of an RF station that sent
 *  "@APRSIS GRID <grid>". Symbol: house ('/-'), comment marks the source. */
function buildPositionPacket(srcCall, gateCall, grid, comment) {
  const pos = gridToAprsLatLon(grid);
  if (!pos) return null;
  const body = `=${pos.lat}/${pos.lon}-${String(comment || 'JS8').slice(0, 36)}`;
  return buildGatePacket(srcCall, gateCall, body);
}

const APRS_IS_HOST = 'rotate.aprs2.net';
const APRS_IS_PORT = 14580;

/** Minimal APRS-IS uplink. Connect → login → send packets. Reconnects with
 *  backoff; 'verified' fires once the server accepts the passcode. */
class AprsIsClient extends EventEmitter {
  constructor({ call, host, port, version } = {}) {
    super();
    this.call = String(call || '').toUpperCase();
    this.host = host || APRS_IS_HOST;
    this.port = port || APRS_IS_PORT;
    this.version = version || '0.0.0';
    this.connected = false;
    this.verified = false;
    this._sock = null;
    this._wantDisconnect = false;
    this._retry = 0;
    this._timer = null;
  }

  connect() {
    this._wantDisconnect = false;
    if (this._sock) return;
    const sock = net.createConnection({ host: this.host, port: this.port });
    this._sock = sock;
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('connect', () => {
      this.connected = true;
      this._retry = 0;
      // No filter: this is an uplink-only session (we inject, we don't feed).
      sock.write(`user ${this.call} pass ${aprsPasscode(this.call)} vers POTACAT ${this.version}\r\n`);
      this.emit('connected');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (/# logresp .*verified/i.test(line) && !/unverified/i.test(line)) {
          this.verified = true;
          this.emit('verified');
        }
        this.emit('line', line);
      }
    });
    const drop = () => {
      const was = this.connected;
      this.connected = false; this.verified = false;
      if (this._sock) { try { this._sock.destroy(); } catch { /* gone */ } this._sock = null; }
      if (was) this.emit('disconnected');
      if (!this._wantDisconnect) {
        const delay = Math.min(60000, 2000 * Math.pow(2, this._retry++));
        this._timer = setTimeout(() => this.connect(), delay);
        if (typeof this._timer.unref === 'function') this._timer.unref();
      }
    };
    sock.on('error', (err) => { this.emit('error', err); drop(); });
    sock.on('close', drop);
  }

  disconnect() {
    this._wantDisconnect = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._sock) { try { this._sock.destroy(); } catch { /* gone */ } this._sock = null; }
    this.connected = false; this.verified = false;
  }

  /** Inject one packet line. Returns false when not connected+verified. */
  send(packet) {
    if (!this._sock || !this.connected || !this.verified) return false;
    try { this._sock.write(packet + '\r\n'); return true; } catch { return false; }
  }
}

module.exports = { AprsIsClient, aprsPasscode, buildGatePacket, gridToAprsLatLon, buildPositionPacket, APRS_IS_HOST, APRS_IS_PORT };

// ── outbound SMS/email builders (the JS8 sender side) ───────────────────────
// The addressee field is EXACTLY 9 chars space-padded — wrong padding is
// dropped silently by the backbone, which is why these exist as code.
function padAddressee(call) {
  const c = String(call || '').toUpperCase().trim().slice(0, 9);
  return c.padEnd(9, ' ');
}
/** ":GATEWAY  :body{NN" — an APRS message to a service gateway. seq 1..99. */
function buildAprsServiceMessage(gatewayCall, body, seq) {
  const gw = padAddressee(gatewayCall);
  if (!gw.trim()) return null;
  const text = String(body || '').replace(/[{}\r\n|~]/g, ' ').trim();
  if (!text) return null;
  const n = Math.max(1, Math.min(99, Math.round(Number(seq) || 1)));
  return ':' + gw + ':' + text + '{' + String(n).padStart(2, '0');
}
function buildSmsMessage(gatewayCall, number, text, seq) {
  const num = String(number || '').replace(/[^0-9+]/g, '');
  if (num.replace(/\D/g, '').length < 7) return null;
  return buildAprsServiceMessage(gatewayCall || 'SMSGTE', `@${num} ${text}`, seq);
}
function buildEmailMessage(gatewayCall, address, text, seq) {
  const addr = String(address || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return null;
  return buildAprsServiceMessage(gatewayCall || 'EMAIL-2', `${addr} ${text}`, seq);
}
module.exports.padAddressee = padAddressee;
module.exports.buildSmsMessage = buildSmsMessage;
module.exports.buildEmailMessage = buildEmailMessage;
