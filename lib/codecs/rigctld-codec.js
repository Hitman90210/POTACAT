'use strict';
/**
 * RigctldCodec — hamlib rigctld text protocol encoder/decoder.
 * Supports standard rigctld commands and Yaesu raw passthrough.
 *
 * When the rig model is Yaesu brand, commands that hamlib backends handle
 * poorly (NB, RF gain, TX power, ATU) are sent as raw Kenwood commands
 * via the 'w' passthrough. This replaces the old _yaesuRaw flag.
 */
const { EventEmitter } = require('events');

function ssbSideband(freqHz) {
  // 60m (≈5.25–5.45 MHz) is USB by convention/regulation despite being below
  // 10 MHz — channelized band, USB mandated worldwide. Everything else: LSB
  // below 10 MHz, USB at/above.
  if (freqHz >= 5250000 && freqHz < 5450000) return 'USB';
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

// Map POTACAT mode names to rigctld mode tokens
const RIGCTLD_MODES = {
  'CW': 'CW', 'USB': 'USB', 'LSB': 'LSB', 'FM': 'FM', 'AM': 'AM',
  'DIGU': 'PKTUSB', 'DIGL': 'PKTLSB', 'PKTUSB': 'PKTUSB', 'PKTLSB': 'PKTLSB',
  'FT8': 'PKTUSB', 'FT4': 'PKTUSB', 'FT2': 'PKTUSB',
  'RTTY': 'RTTY',
};

// Sensible default passband (Hz) per rigctld mode token. Used when the user
// hasn't configured an explicit filter width in POTACAT Settings. Prevents
// the "rig defaults PKTUSB to 500 Hz" trap on some hamlib backends (Yaesu
// FT991 in particular). An explicit setFilterWidth call from the rig
// controller's tune pipeline overrides this.
function defaultPassbandFor(token) {
  switch (token) {
    case 'PKTUSB':
    case 'PKTLSB':  return 3000;  // FT8/FT4/JS8/PSK need wide
    case 'USB':
    case 'LSB':     return 2400;  // standard SSB
    case 'CW':
    case 'CWR':     return 500;
    case 'RTTY':
    case 'RTTYR':   return 500;
    // AM and FM: send 0 (backend default = wide) so Yaesu rigs don't drop
    // into narrow on every mode change. AB9AI 2026-05-04: switching to AM
    // via ECHOCAT picked the 6 kHz narrow filter (NAR indicator on FTdx3000)
    // because we were sending `M AM 6000`, and the renderer only knew about
    // `AM` so it never showed the PTT button when the rig reported `AMN`
    // back. FT-991/FTDX10/FTdx3000 wide AM is 9 kHz, wide FM is 25 kHz —
    // sending the narrow values forced narrow on every AM/FM tune. Backend
    // default lands the rig in whichever filter it last used or the rig's
    // natural wide bandwidth. Users who want narrow can configure it via
    // Settings → Filter Width or the rig itself.
    case 'AM':      return 0;
    case 'FM':      return 0;
    case 'FMN':     return 15000; // explicit narrow-FM token if mapped
    default:        return 0;     // fall back to backend default
  }
}

// hamlib RPRT code → human meaning. Codes are the negated values of the
// RIG_E* errno constants in include/hamlib/rig.h. Surfacing these as text
// turns "rigctld error: RPRT -20" (which means nothing to a user) into
// "Radio reports it's powered off" (which tells them what to do).
const RPRT_MEANINGS = {
  0: 'OK',
  '-1': 'Invalid argument',
  '-2': 'Configuration error',
  '-3': 'Out of memory',
  '-4': 'Function not implemented',
  '-5': 'Communication timed out — radio not responding (check cable / baud rate / power)',
  '-6': 'I/O error on serial port',
  '-7': 'Internal hamlib error',
  '-8': 'Protocol error — radio reply did not match expected format (wrong rig model?)',
  '-9': 'Command rejected by the radio',
  '-10': 'Reply truncated',
  '-11': 'Function not available on this radio',
  '-12': 'VFO not targetable',
  '-13': 'Bus error',
  '-14': 'Bus is busy',
  '-15': 'Bad argument value',
  '-16': 'VFO error',
  '-17': 'Argument out of range',
  '-18': 'Function deprecated',
  '-19': 'Security restriction',
  '-20': 'Radio reports it is powered off — turn the radio on (or use POTACAT Rig → Power On) and try again',
  '-21': 'Limit exceeded',
  '-22': 'Access denied',
};

function rprtMessage(line) {
  // line is e.g. "RPRT -20" or "RPRT 0"
  const m = (line || '').match(/RPRT\s+(-?\d+)/);
  if (!m) return null;
  return RPRT_MEANINGS[m[1]] || null;
}

// ATU sequences for Yaesu raw passthrough
// Different Yaesu generations interpret the AC command differently — there's
// no one-size code. If a model's selected variant doesn't work, the user can
// trial-and-error via Settings > Rig > Custom Command and report back so we
// can add the right preset here.
const ATU_SEQUENCES = {
  'ft891': [{ cmd: 'w AC001;\n', delay: 0 }, { cmd: 'w AC002;\n', delay: 300 }],
  'ac002': [{ cmd: 'w AC002;\n', delay: 0 }],
  'ac003': [{ cmd: 'w AC003;\n', delay: 0 }], // FT-710 Tuner Activate — tunes from off or on (baumertjohn #55)
  'ac103': [{ cmd: 'w AC103;\n', delay: 0 }], // FTX-1 Optima (W9JL) — P1=1, P3=3
  'standard': [{ cmd: 'w AC011;\n', delay: 0 }],
};

class RigctldCodec extends EventEmitter {
  /**
   * @param {object} model — rig model entry
   * @param {function} writeFn — writes string to transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model;
    this._write = writeFn;
    this._yaesuRaw = model.brand === 'Yaesu';
    this._atuCmd = model.atuCmd || 'standard';
    this._minPower = model.minPower || 5;
    this._maxPower = model.maxPower || 100;
    this._setPowerCmd = model.commands && model.commands.setPower;
    this._powerMap = model.powerMap || null;
    this._modes = Object.assign({}, RIGCTLD_MODES, model.modes || {});

    // Response parser state
    this._buf = '';
    this._expectPassband = false;
    this._expectNb = false;
    this._expectSmeter = false;
    this._expectPtt = false;
    this._nbUnsupported = false;
    this._pttUnsupported = false;
    this._expectVfo = false;
    this._expectSplit = false;
    this._expectSplitVfo = false;
    this._lastRprtCode = null;
    this._lastMode = null;
    this._lastFreqHz = 0;

    // Preamp/ATT are hamlib LEVELS in dB, and backends (icom.c at least)
    // require an EXACT match against the rig's caps list — a guessed dB is
    // rejected with RPRT -1. probeCaps() dump_caps-parses the real lists at
    // connect; these are the fallbacks if the probe never answers.
    this._preampDb = 0;      // 0 = unknown → setPreamp falls back to 10
    this._attDb = 0;         // 0 = unknown → setAttenuator falls back to 12
    this._dumpCapsUntil = 0; // parser is in dump_caps-swallow mode until this ms epoch
    // Last user-initiated command, for RPRT error attribution: a rejection
    // arriving within ~1.5s of a control click almost certainly answers it,
    // and naming the command turns "RPRT -11" into an actionable log line.
    // (K6RBJ spent weeks on controls that failed with no trace, 2026-08-03.)
    this._lastUserCmd = null; // { cmd, ts }
  }

  /**
   * Probe the rig's capability lists via \dump_caps. Called by the
   * controller at connect, BEFORE the safety `T 0` — rigctld answers
   * sequentially, so the `RPRT` that follows the dump (either dump_caps'
   * own terminator or the T 0 reply) deterministically ends swallow mode.
   * A 1.5s timeout backstops rigctld builds that answer neither.
   */
  probeCaps() {
    if (this._yaesuRaw) return; // Yaesu path uses raw passthrough, no levels needed
    this._dumpCapsUntil = Date.now() + 1500;
    this._write('\\dump_caps\n');
  }

  _noteUserCmd(cmd) {
    this._lastUserCmd = { cmd: cmd.trim(), ts: Date.now() };
  }

  // --- Command generation ---

  setFrequency(hz) {
    this._write(`F ${hz}\n`);
  }

  getFrequency() {
    this._write('f\n');
  }

  /**
   * Set mode. Returns the rigctld mode token used.
   *
   * rigctld's `M <mode> <passband>` second argument:
   *   0  = backend default passband
   *   -1 = no change
   *   >0 = explicit Hz
   *
   * We used to send 0 (backend default), but some rigs — notably the Yaesu
   * FT991 via hamlib — default PKTUSB/PKTLSB to 500 Hz, which is useless
   * for FT8/FT4 (needs ~3 kHz). Sending mode-appropriate defaults here
   * gives a sensible RX bandwidth on first mode switch, without forcing
   * users to configure SSB/CW/Digital Filter Width in POTACAT Settings.
   * Users who DO set a POTACAT filter width override this via setFilterWidth
   * after the mode change (the rig-controller tune pipeline calls filter
   * last, so the explicit value wins). (phsdv, FT991, issue #21)
   */
  setMode(modeName, freqHz) {
    let token = this.resolveMode(modeName, freqHz);
    // Preserve the operator's CW / RTTY SIDEBAND. CW-R (= CW-L on Yaesu) and
    // RTTY-R are the operator's choice, not something a spot should override.
    // When they ask for CW and the rig is already in CW-R, re-send CWR — not CW
    // — so the mode-after-freq band-recall resend can't yank the FTDX10 out of
    // CW-L back to CW-U on every CW spot tune (AE4XO 2026-07-24). Only when the
    // rig is currently in the reverse variant; a switch INTO CW from SSB still
    // uses plain CW, and the op flips to CW-R once if they want it.
    if (token === 'CW' && this._lastMode === 'CWR') token = 'CWR';
    else if (token === 'RTTY' && this._lastMode === 'RTTYR') token = 'RTTYR';
    if (token) {
      // Only attach a mode-appropriate passband when the rig actually
      // supports filter adjustment. Sending e.g. "M USB 2400" to an FT-857
      // via hamlib makes the backend reject the whole command with
      // RPRT -1 because that rig has only fixed filters and 2400 isn't in
      // the allowed list — the mode never changes. Falling back to 0
      // (backend default) is universally accepted. Rigs that DO support
      // filter (FT-991, etc.) keep getting the mode-appropriate passband
      // so FT8/FT4 still come up at ~3 kHz.
      const supportsFilter = !!(this._model.caps && this._model.caps.filter);
      const pb = supportsFilter ? defaultPassbandFor(token) : 0;
      this._write(`M ${token} ${pb}\n`);
      this._lastMode = token;
    }
    return token;
  }

  getMode() {
    this._write('m\n');
  }

  resolveMode(modeName, freqHz) {
    let m = (modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);
    return this._modes[m] || RIGCTLD_MODES[m] || null;
  }

  setTransmit(on) {
    const line = on ? 'T 1\n' : 'T 0\n';
    this.emit('log', `PTT write: ${JSON.stringify(line)}`);
    this._write(line);
  }

  /**
   * Query current PTT state. Hamlib returns "0" (RX) or "1" (TX). Used to
   * detect physical-mic / footswitch / external PTT so the SWR / ALC poll
   * (TX-only) can fire even when POTACAT itself didn't issue the keying.
   * AB9AI on FTdx3000 reported smeter still polling and SWR/ALC frozen
   * during physical-mic TX (2026-05-04).
   */
  getPtt() {
    if (this._pttUnsupported) return;
    this._expectPtt = true;
    this._write('t\n');
  }

  setNb(on) {
    if (this._yaesuRaw) {
      this._write(`w NB0${on ? 1 : 0};\n`);
    } else {
      const line = `U NB ${on ? 1 : 0}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  getNb() {
    if (this._nbUnsupported) return;
    this._expectNb = true;
    this._write('u NB\n');
  }

  getSmeter() {
    this._expectSmeter = true;
    this._write('l STRENGTH\n');
  }

  getSwr() {
    this._expectSwr = true;
    this._write('l SWR\n');
  }

  getAlc() {
    this._expectAlc = true;
    this._write('l ALC\n');
  }

  setRfGain(pct) {
    if (this._yaesuRaw) {
      const clamped = Math.max(0, Math.min(255, Math.round(pct * 255)));
      this._write(`w RG0${String(clamped).padStart(3, '0')};\n`);
    } else {
      // hamlib's RF-gain level token is `RF`, not `RFGAIN` — the old token
      // was rejected as an invalid level on every rigctld rig (K6RBJ asked
      // for working RF gain three times before this was diagnosed, 2026-08-03).
      const line = `L RF ${pct.toFixed(3)}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  setSquelch(pct) {
    // pct is a 0.0-1.0 fraction (dispatcher divides the app 0-100 by 100, as
    // for RF gain). Yaesu raw SQ is 000-100 (not 000-255 like RG).
    const frac = Math.max(0, Math.min(1, Number(pct) || 0));
    if (this._yaesuRaw) {
      const clamped = Math.round(frac * 100);
      this._write(`w SQ0${String(clamped).padStart(3, '0')};\n`);
    } else {
      this._write(`L SQL ${frac.toFixed(3)}\n`);
    }
  }

  setTxPower(fraction) {
    if (this._yaesuRaw) {
      const watts = Math.max(this._minPower, Math.min(this._maxPower, Math.round(fraction * this._maxPower)));
      const encoded = this._powerMap && this._powerMap[watts] != null ? this._powerMap[watts] : watts;
      const cmd = this._setPowerCmd
        ? this._setPowerCmd.replace('{val:pad3}', String(encoded).padStart(3, '0')).replace('{val}', String(encoded))
        : `PC${String(encoded).padStart(3, '0')};`;
      this._write(`w ${cmd}\n`);
    } else {
      this._write(`L RFPOWER ${fraction.toFixed(3)}\n`);
    }
  }

  getPower() {
    // rigctld doesn't have a reliable power query — skip
  }

  setFilterWidth(hz) {
    if (!hz) return;
    const mode = this._lastMode || 'USB';
    this._write(`M ${mode} ${hz}\n`);
  }

  setVfo(vfo) {
    this._write(`V VFO${(vfo || 'A').toUpperCase()}\n`);
  }

  /**
   * Poll active VFO + split state (`v` + `s`). hamlib's `f` already returns
   * the CURRENT VFO's frequency, so unlike the Kenwood path this is purely
   * for the indicator/state — the display was never wrong here, just blind.
   * `s` (get_split_vfo) answers TWO lines: split 0/1, then the TX VFO name —
   * both consumed via expect flags BEFORE the mode branch, or "VFOB" would
   * parse as a phantom mode (the ^[A-Z]{2,8}$ trap).
   */
  getVfoSplit() {
    this._expectVfo = true;
    this._write('v\n');
    this._expectSplit = true;
    this._write('s\n');
  }

  swapVfo() {
    // rigctld doesn't have a direct swap — set opposite VFO
  }

  setSplit(on) {
    // rigctld split command: `S <on/off> <tx-vfo>`. VFO token is ignored when
    // disabling, but hamlib requires a placeholder.
    this._write(on ? 'S 1 VFOB\n' : 'S 0 VFOA\n');
  }

  setPowerState(on) {
    const line = `\\set_powerstat ${on ? 1 : 0}\n`;
    this._noteUserCmd(line);
    this._write(line);
  }

  /** Returns ATU sequence for the rig */
  getAtuStartSequence() {
    if (this._yaesuRaw) {
      return ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
    }
    return [{ cmd: 'U TUNER 1\n', delay: 0 }];
  }

  getAtuStopCmd() {
    return this._yaesuRaw ? 'w AC000;\n' : 'U TUNER 0\n';
  }

  startTune() {
    // For Yaesu, use the variant configured for this model rather than a
    // hardcoded AC011 (which doesn't work for FT-891-style or FTX-1-style
    // radios). For non-Yaesu, fall through to the standard rigctld TUNER fn.
    if (this._yaesuRaw) {
      const seq = ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
      this.emit('log', `ATU start (variant=${this._atuCmd}): ${seq.map(s => s.cmd.trim()).join(' then ')}`);
      let delay = 0;
      for (const step of seq) {
        delay += step.delay || 0;
        if (delay === 0) this._write(step.cmd);
        else setTimeout(() => this._write(step.cmd), delay);
      }
    } else {
      this.emit('log', 'ATU start: U TUNER 1');
      this._write('U TUNER 1\n');
    }
  }
  stopTune() {
    const line = this._yaesuRaw ? 'w AC000;\n' : 'U TUNER 0\n';
    this.emit('log', `ATU stop: ${line.trim()}`);
    this._write(line);
  }

  sendCwText(text) {
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-]/g, '');
    const line = `b ${clean}\n`;
    this.emit('log', `CW write: ${JSON.stringify(line)} (${clean.length} chars)`);
    this._write(line);
  }

  setCwSpeed(wpm) {
    const clamped = Math.max(5, Math.min(50, Math.round(wpm)));
    this._write(`L KEYSPD ${clamped}\n`);
  }

  // --- Extended controls ---

  setNbLevel(val) {
    if (this._yaesuRaw) this._write(`w NL0${String(val).padStart(3, '0')};\n`);
    // No standard rigctld equivalent for NB level
  }

  setAfGain(pct) {
    if (this._yaesuRaw) {
      const scaled = Math.max(0, Math.min(255, Math.round(pct * 255)));
      this._write(`w AG0${String(scaled).padStart(3, '0')};\n`);
    } else {
      this._write(`L AF ${pct.toFixed(3)}\n`);
    }
  }

  setPreamp(on) {
    if (this._yaesuRaw) {
      this._write(`w PA0${on ? 1 : 0};\n`);
    } else {
      // hamlib has no PREAMP *function* — preamp is a LEVEL in dB (0 = off),
      // and backends exact-match the dB against the rig's caps list, hence
      // the probeCaps() dump at connect. `U PREAMP` was silently rejected on
      // every rigctld rig (K6RBJ IC-7100, 2026-08-03).
      const line = `L PREAMP ${on ? (this._preampDb || 10) : 0}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  setAttenuator(on) {
    if (this._yaesuRaw) {
      this._write(`w RA0${on ? 1 : 0};\n`);
    } else {
      // Same story as preamp: ATT is a hamlib LEVEL in dB, not a function.
      const line = `L ATT ${on ? (this._attDb || 12) : 0}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  setNoiseReduction(on) {
    if (this._yaesuRaw) {
      this._write(`w NR0${on ? 1 : 0};\n`); // same raw form the Kenwood codec's Yaesu path uses
    } else {
      // NR genuinely IS a hamlib function — it was simply never implemented
      // here, so the controller's typeof guard no-opped it (K6RBJ 2026-08-03).
      const line = `U NR ${on ? 1 : 0}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  setNrLevel(pct) {
    // pct is the app's 0-100 scale (see main.js set-nr-level).
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (this._yaesuRaw) {
      // Yaesu RL: 1..15 depth scale — mirror kenwood-codec's mapping.
      const v = Math.max(1, Math.min(15, Math.round((clamped / 100) * 15)));
      this._write(`w RL0${String(v).padStart(2, '0')};\n`);
    } else {
      const line = `L NR ${(clamped / 100).toFixed(3)}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  vfoCopyAB() {
    if (this._yaesuRaw) this._write('w AB;\n');
  }

  vfoCopyBA() {
    if (this._yaesuRaw) this._write('w BA;\n');
  }

  sendRaw(text) {
    const cmd = text.replace(/[\r\n]/g, '').trim();
    if (!cmd) return;
    // Detect space-separated hex bytes (e.g. "FE FE 80 E0 16 22 01 FD")
    // and convert to \x escape sequences for rigctld's w command
    const hexParts = cmd.split(/\s+/);
    const isHex = hexParts.length >= 2 && hexParts.every(p => /^[0-9a-fA-F]{2}$/.test(p));
    if (isHex) {
      const escaped = hexParts.map(h => '\\x' + h.toLowerCase()).join('');
      this._noteUserCmd(`w ${escaped}`);
      this._write(`w ${escaped}\n`);
    } else {
      this._noteUserCmd(`w ${cmd}`);
      this._write(`w ${cmd}\n`);
    }
  }

  // --- Response parsing ---

  onData(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      this._parseLine(line);
    }
  }

  _parseLine(line) {
    // dump_caps swallow mode (see probeCaps): consume the capability dump so
    // its free-form lines can't misparse as freq/mode, keeping only the
    // Preamp/Attenuator dB lists. The first RPRT (dump terminator or the
    // T 0 reply queued behind the dump) ends the mode deterministically.
    if (this._dumpCapsUntil) {
      if (/^RPRT\s+-?\d+/.test(line) || Date.now() > this._dumpCapsUntil) {
        this._dumpCapsUntil = 0;
        if (this._preampDb || this._attDb) {
          this.emit('log', `caps probe: preamp=${this._preampDb || 'n/a'}dB att=${this._attDb || 'n/a'}dB`);
        }
        return; // the RPRT itself belongs to the dump/safety-PTT — consume it
      }
      let m;
      if ((m = line.match(/^Preamp:\s*(.+)$/i))) {
        const dbs = [...m[1].matchAll(/(\d+)\s*dB/gi)].map((x) => parseInt(x[1], 10));
        if (dbs.length) this._preampDb = dbs[0]; // lowest step = safe "on" value
      } else if ((m = line.match(/^Attenuator:\s*(.+)$/i))) {
        const dbs = [...m[1].matchAll(/(\d+)\s*dB/gi)].map((x) => parseInt(x[1], 10));
        if (dbs.length) this._attDb = dbs[0];
      }
      return;
    }

    // Passband after mode response — skip, but validate it's actually a passband
    if (this._expectPassband) {
      this._expectPassband = false;
      if (/^\d+$/.test(line) && parseInt(line, 10) <= 100000) {
        return; // genuine passband
      }
      // Fall through — not a passband (e.g. FLRig omits it)
    }

    // RPRT responses — clear all pending expectations (command was answered)
    if (/^RPRT\s+-?\d+/.test(line)) {
      const code = parseInt(line.split(/\s+/)[1], 10);
      if (this._expectNb) {
        this._expectNb = false;
        if (code !== 0) this._nbUnsupported = true;
      }
      if (this._expectPtt) {
        this._expectPtt = false;
        if (code !== 0) this._pttUnsupported = true;
      }
      this._expectSmeter = false;
      this._expectSwr = false;
      this._expectAlc = false;
      this._expectVfo = false;
      this._expectSplit = false;
      this._expectSplitVfo = false;
      if (code !== 0) {
        const meaning = RPRT_MEANINGS[String(code)] || 'command not supported or failed';
        // Attribution: a rejection within ~1.5s of a control click almost
        // certainly answers it. Always log those (even a repeated code) and
        // NAME the command — an anonymous "RPRT -11" told K6RBJ nothing for
        // weeks. Unattributed errors (poll noise) keep the on-change dedup.
        const u = this._lastUserCmd;
        if (u && Date.now() - u.ts < 1500) {
          this._lastUserCmd = null; // one attribution per action
          this.emit('log', `rx: ${line} (${meaning}) — likely rejecting "${u.cmd}"`);
        } else if (code !== this._lastRprtCode) {
          this.emit('log', `rx: ${line} (${meaning})`);
        }
      }
      this._lastRprtCode = code;
      return;
    }

    // PTT response: "0" (RX) or "1" (TX) — check before NB since both consume
    // the same shape and polling order is PTT first. Must beat the frequency
    // path so "1" isn't parsed as 1 Hz.
    if (this._expectPtt && /^[01]$/.test(line)) {
      this._expectPtt = false;
      this.emit('ptt', line === '1');
      return;
    }

    // NB response: "0" or "1" — check BEFORE frequency to avoid "1" being parsed as 1 Hz
    if (this._expectNb && /^[01]$/.test(line)) {
      this._expectNb = false;
      this.emit('nb', line === '1');
      return;
    }

    // Active-VFO response ("VFOA"/"VFOB", also "MEM" etc. on some backends) —
    // must be consumed here or it falls into the mode branch as a phantom
    // mode. Checked AFTER ptt/nb so their earlier-commanded 0/1 lines can't
    // be stolen, and order-of-send (v before s) keeps pairings straight.
    if (this._expectVfo && /^(VFO[AB]|MEM|Main|Sub|currVFO)$/i.test(line)) {
      this._expectVfo = false;
      const m = line.match(/^VFO([AB])$/i);
      if (m) this.emit('vfo', m[1].toUpperCase());
      return;
    }

    // Split response line 1: "0"/"1". Line 2 (the TX VFO name) follows and
    // must also be consumed so it can't misparse as a mode.
    if (this._expectSplit && /^[01]$/.test(line)) {
      this._expectSplit = false;
      this._expectSplitVfo = true;
      this.emit('split', line === '1');
      return;
    }
    if (this._expectSplitVfo && /^(VFO[AB]|MEM|Main|Sub|currVFO)$/i.test(line)) {
      this._expectSplitVfo = false;
      return; // TX VFO name — consumed, not surfaced
    }

    // S-meter response: hamlib `l STRENGTH` returns dB relative to S9
    // (S9=0, S0=-54, S9+20=+20, S9+60=+60). Map to 0-255 for UI.
    // AB9AI bug: when poll order is freq → mode → smeter, the freq response
    // (e.g. "14250000") arrives while _expectSmeter is true. We must NOT
    // clear the expectation just because this integer is out of S-meter
    // range — the actual S-meter response is still on its way. Just fall
    // through and let the frequency path consume large integers.
    if (this._expectSmeter && /^-?\d+$/.test(line)) {
      const val = parseInt(line, 10);
      if (val >= -200 && val <= 100) {
        this._expectSmeter = false;
        // Map: -54 -> 0 (S0), 0 -> 120 (S9), +60 -> 255 (S9+60)
        const scaled = Math.max(0, Math.min(255, Math.round((val + 54) * 255 / 114)));
        this.emit('log', `rx: ${val} -> smeter=${scaled}`);
        this.emit('smeter', scaled);
        return;
      }
    }

    // SWR response: hamlib `l SWR` returns float ratio (1.0..10.0+).
    // UI expects a 0-255 scale where val/60 + 1 = ratio (val=60 -> 2.0,
    // val=120 -> 3.0). Same out-of-range tolerance as smeter so a freq
    // response in the same poll cycle doesn't strand the expectation.
    if (this._expectSwr && /^-?\d+(\.\d+)?$/.test(line)) {
      const ratio = parseFloat(line);
      if (ratio >= 0.5 && ratio <= 100) {
        this._expectSwr = false;
        const scaled = Math.max(0, Math.min(255, Math.round((ratio - 1.0) * 60)));
        this.emit('log', `rx: ${ratio} -> swr=${scaled}`);
        this.emit('swr', scaled);
        return;
      }
    }

    // ALC response: hamlib `l ALC` returns float 0.0..1.0.
    // UI expects 0-255 (val/255 = fraction).
    if (this._expectAlc && /^-?\d+(\.\d+)?$/.test(line)) {
      const frac = parseFloat(line);
      if (frac >= -0.01 && frac <= 1.5) {
        this._expectAlc = false;
        const scaled = Math.max(0, Math.min(255, Math.round(frac * 255)));
        this.emit('log', `rx: ${frac} -> alc=${scaled}`);
        this.emit('alc', scaled);
        return;
      }
    }

    // Frequency: plain integer (must be > 100 kHz to be a real frequency)
    if (/^\d+$/.test(line)) {
      const hz = parseInt(line, 10);
      if (!isNaN(hz) && hz > 100000) {
        if (hz !== this._lastFreqHz) {
          this.emit('log', `rx: ${hz} -> freq=${(hz / 1000).toFixed(1)}kHz`);
          this._lastFreqHz = hz;
        }
        this.emit('frequency', hz);
      }
      return;
    }

    // Mode: uppercase letters 2-8 chars
    if (/^[A-Z]{2,8}$/.test(line) && !line.startsWith('RPRT')) {
      this._expectPassband = true;
      this._lastMode = line;
      this.emit('mode', line);
      this.emit('log', `rx: ${line} -> mode=${line}`);
      return;
    }

    // NB response already handled above (before frequency check)
    // This catches any remaining single-digit responses
    if (this._expectNb && /^[01]$/.test(line)) {
      this._expectNb = false;
      this.emit('nb', line === '1');
      return;
    }
  }

  get lastMode() { return this._lastMode; }
  set lastMode(m) { this._lastMode = m; }

  /** Return the resolved command table for the Table tab UI */
  getCommandTable() {
    const y = this._yaesuRaw;
    const entries = [
      { key: 'getFreq', label: 'Get Frequency', value: 'f' },
      { key: 'setFreq', label: 'Set Frequency', value: 'F {freq}' },
      { key: 'getMode', label: 'Get Mode', value: 'm' },
      { key: 'setMode', label: 'Set Mode', value: 'M {mode} 0' },
      { key: 'setTransmitOn', label: 'PTT On', value: 'T 1' },
      { key: 'setTransmitOff', label: 'PTT Off', value: 'T 0' },
      { key: 'setNbOn', label: 'NB On', value: y ? 'w NB01;' : 'U NB 1' },
      { key: 'setNbOff', label: 'NB Off', value: y ? 'w NB00;' : 'U NB 0' },
      { key: 'getNb', label: 'Get NB', value: 'u NB' },
      { key: 'getSmeter', label: 'S-Meter', value: 'l STRENGTH' },
      { key: 'getSwr', label: 'SWR', value: 'l SWR' },
      { key: 'getAlc', label: 'ALC', value: 'l ALC' },
      { key: 'setRfGain', label: 'RF Gain', value: y ? 'w RG0{val};' : 'L RF {val}' },
      { key: 'setPower', label: 'TX Power', value: y ? 'w PC{val};' : 'L RFPOWER {val}' },
      { key: 'setFilter', label: 'Filter Width', value: 'M {mode} {hz}' },
      { key: 'setVfoA', label: 'VFO A', value: 'V VFOA' },
      { key: 'setVfoB', label: 'VFO B', value: 'V VFOB' },
      { key: 'setSplit', label: 'Split On', value: 'S 1 VFOB' },
      { key: 'setPowerOn', label: 'Power On', value: '\\set_powerstat 1' },
      { key: 'setPowerOff', label: 'Power Off', value: '\\set_powerstat 0' },
    ];
    // ATU
    const atuSeq = this.getAtuStartSequence();
    if (atuSeq && atuSeq.length > 0) {
      const atuStr = atuSeq.map(s => s.cmd.replace(/\n$/, '')).join(' -> ');
      entries.push({ key: 'atuTune', label: 'ATU Tune', value: atuStr });
    }
    // Extended Yaesu controls
    if (y) {
      entries.push({ key: 'setNbLevel', label: 'NB Level', value: 'w NL0{val};' });
      entries.push({ key: 'setAfGain', label: 'AF Gain', value: 'w AG0{val};' });
      entries.push({ key: 'setPreampOn', label: 'Preamp On', value: 'w PA01;' });
      entries.push({ key: 'setPreampOff', label: 'Preamp Off', value: 'w PA00;' });
      entries.push({ key: 'setAttenuatorOn', label: 'Atten On', value: 'w RA01;' });
      entries.push({ key: 'setAttenuatorOff', label: 'Atten Off', value: 'w RA00;' });
      entries.push({ key: 'setNrOn', label: 'NR On', value: 'w NR01;' });
      entries.push({ key: 'setNrOff', label: 'NR Off', value: 'w NR00;' });
      entries.push({ key: 'vfoCopyAB', label: 'VFO Copy A->B', value: 'w AB;' });
      entries.push({ key: 'vfoCopyBA', label: 'VFO Copy B->A', value: 'w BA;' });
    } else {
      const pre = this._preampDb || 10;
      const att = this._attDb || 12;
      entries.push({ key: 'setAfGain', label: 'AF Gain', value: 'L AF {val}' });
      entries.push({ key: 'setPreampOn', label: 'Preamp On', value: `L PREAMP ${pre}` });
      entries.push({ key: 'setPreampOff', label: 'Preamp Off', value: 'L PREAMP 0' });
      entries.push({ key: 'setAttenuatorOn', label: 'Atten On', value: `L ATT ${att}` });
      entries.push({ key: 'setAttenuatorOff', label: 'Atten Off', value: 'L ATT 0' });
      entries.push({ key: 'setNrOn', label: 'NR On', value: 'U NR 1' });
      entries.push({ key: 'setNrOff', label: 'NR Off', value: 'U NR 0' });
      entries.push({ key: 'setNrLevel', label: 'NR Level', value: 'L NR {val}' });
    }
    return entries;
  }
}

module.exports = { RigctldCodec, RPRT_MEANINGS, rprtMessage };
