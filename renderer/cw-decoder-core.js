// Lightweight CW decoder core for the experimental CW decoder popout.
//
// This intentionally stays dependency-free, but the timing model borrows the
// practical shape used by skimmer-style decoders: keep duration histories,
// cluster dits/dahs and gaps, and avoid emitting text before timing is trusted.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CwDecoderCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const MORSE = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
    '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
    '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
    '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
    '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
    '--..': 'Z',
    '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5',
    '-....': '6', '--...': '7', '---..': '8', '----.': '9', '-----': '0',
    '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'",
    '-.-.--': '!', '-..-.': '/', '-.--.': '(', '-.--.-': ')',
    '.-...': '&', '---...': ':', '-.-.-.': ';', '-...-': '=',
    '.-.-.': '+', '-....-': '-', '..--.-': '_', '.-..-.': '"',
    '...-..-': '$', '.--.-.': '@',
  };

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  class CwDecoderCore {
    constructor(opts = {}) {
      this.minWpm = opts.minWpm || 5;
      this.maxWpm = opts.maxWpm || 45;
      this.autoTiming = opts.autoTiming !== false;
      this.ditMs = 1200 / (opts.wpm || 18);
      this._manualWpm = opts.wpm || 18;
      this._speedLocked = !this.autoTiming;
      this._dahDitRatio = 3.0;
      this._onDurations = [];
      this._offDurations = [];
      this._maxHistory = 48;
      this.reset();
    }

    reset() {
      this.state = false;
      this.stateMs = 0;
      this.haveState = false;
      this.symbol = '';
      this.text = '';
      this.events = [];
      this._preBuffer = [];
      this._charFlushedForSpace = false;
      this._wordFlushedForSpace = false;
      if (!this.autoTiming) {
        this._speedLocked = true;
        this.ditMs = 1200 / this._manualWpm;
      }
    }

    get wpm() {
      return Math.round(1200 / this.ditMs);
    }

    get speedLocked() {
      return this._speedLocked;
    }

    setWpm(wpm) {
      const clamped = clamp(Number(wpm) || 18, this.minWpm, this.maxWpm);
      this._manualWpm = clamped;
      this.ditMs = 1200 / clamped;
      if (!this.autoTiming) this._speedLocked = true;
    }

    setAutoTiming(enabled) {
      this.autoTiming = enabled !== false;
      this._speedLocked = !this.autoTiming;
      if (!this.autoTiming) {
        this.ditMs = 1200 / this._manualWpm;
        this._preBuffer = [];
      }
    }

    processKeyed(keyed, dtMs) {
      keyed = !!keyed;
      dtMs = Math.max(1, Number(dtMs) || 1);
      this.events = [];

      if (!this.haveState) {
        this.haveState = true;
        this.state = keyed;
        this.stateMs = dtMs;
        return this.events;
      }

      if (keyed === this.state) {
        this.stateMs += dtMs;
        if (!this.state) this._maybeFlushOngoingSpace();
        return this.events;
      }

      const elapsed = this.stateMs;
      if (this.state) this._processOnDuration(elapsed);
      else this._processOffDuration(elapsed);

      this.state = keyed;
      this.stateMs = dtMs;
      if (keyed) {
        this._charFlushedForSpace = false;
        this._wordFlushedForSpace = false;
      }
      return this.events;
    }

    flush() {
      this.events = [];
      this._finalizeCharacter();
      return this.events;
    }

    _processOnDuration(ms) {
      if (ms < 10 || ms > 1200) return;

      const wasLocked = this._speedLocked;
      if (!wasLocked) this._buffer({ type: 'on', duration: ms });

      if (this.autoTiming && this._isPlausibleMark(ms)) {
        this._onDurations.push(ms);
        if (this._onDurations.length > this._maxHistory) this._onDurations.shift();
        this._updateSpeedEstimate();
      }

      if (!wasLocked && this._speedLocked) return;
      if (!this._speedLocked) return;

      const threshold = this.ditMs * Math.sqrt(this._dahDitRatio);
      this.symbol += ms < threshold ? '.' : '-';
      this.events.push({ type: 'mark', value: ms < threshold ? 'dit' : 'dah', ms });

      if (this.symbol.length > 8) this._finalizeCharacter();
    }

    _processOffDuration(ms) {
      if (ms < 8) return;
      if (!this._speedLocked) this._buffer({ type: 'off', duration: ms });

      if (ms <= this.ditMs * 15) {
        this._offDurations.push(ms);
        if (this._offDurations.length > this._maxHistory) this._offDurations.shift();
      }

      if (!this._speedLocked) return;
      this._classifyGap(ms);
    }

    _classifyGap(ms) {
      const { charGap, wordGap } = this._getGapThresholds();
      if (ms >= wordGap || ms > this.ditMs * 15) {
        this._finalizeCharacter();
        this._appendSpace();
      } else if (ms >= charGap) {
        this._finalizeCharacter();
      }
    }

    _maybeFlushOngoingSpace() {
      if (!this._speedLocked || !this.symbol) return;
      const { charGap, wordGap } = this._getGapThresholds();
      if (!this._charFlushedForSpace && this.stateMs >= charGap) {
        this._finalizeCharacter();
        this._charFlushedForSpace = true;
      }
      if (!this._wordFlushedForSpace && this.stateMs >= wordGap) {
        this._appendSpace();
        this._wordFlushedForSpace = true;
      }
    }

    _finalizeCharacter() {
      if (!this.symbol) return;
      if (!this._speedLocked) {
        this.symbol = '';
        return;
      }
      const code = this.symbol;
      const ch = MORSE[code] || '?';
      this.text += ch;
      this.events.push({ type: 'char', code, char: ch, text: this.text });
      this.symbol = '';
    }

    _appendSpace() {
      if (!this.text || this.text.endsWith(' ')) return;
      this.text += ' ';
      this.events.push({ type: 'space', text: this.text });
    }

    _buffer(entry) {
      this._preBuffer.push(entry);
      if (this._preBuffer.length > 140) this._preBuffer.shift();
    }

    _isPlausibleMark(ms) {
      const minDit = 1200 / this.maxWpm;
      const maxDah = (1200 / this.minWpm) * 3.6;
      if (ms < minDit * 0.5 || ms > maxDah) return false;
      if (!this._speedLocked) return true;
      return ms >= this.ditMs * 0.5 && ms <= this.ditMs * 4.2;
    }

    _updateSpeedEstimate() {
      if (this._onDurations.length < 5) return;
      const sorted = this._onDurations.slice().sort((a, b) => a - b);

      let bestRatio = 0;
      let split = 0;
      for (let i = 1; i < sorted.length; i++) {
        const ratio = sorted[i] / Math.max(1, sorted[i - 1]);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          split = i;
        }
      }

      let estDit = 0;
      let dahDitRatio = 3.0;

      if (bestRatio >= 1.45 && split >= 2 && sorted.length - split >= 1) {
        const dits = sorted.slice(0, split);
        const dahs = sorted.slice(split);
        estDit = median(dits);
        dahDitRatio = median(dahs) / Math.max(1, estDit);
        if (dahDitRatio < 1.45 || dahDitRatio > 5.0) return;
        if (!this._speedLocked && dits.length < 3) return;
      } else if (!this._speedLocked && sorted.length >= 8) {
        // If we have mostly dits (common with CQ/test strings), lock to the
        // shortest stable cluster instead of waiting forever for dah evidence.
        const shortest = sorted.slice(0, Math.max(4, Math.floor(sorted.length * 0.45)));
        estDit = median(shortest);
        const maxDev = Math.max(...shortest.map(v => Math.abs(v - estDit) / Math.max(1, estDit)));
        if (maxDev > 0.35) return;
      } else {
        return;
      }

      const estWpm = 1200 / estDit;
      if (estWpm < this.minWpm || estWpm > this.maxWpm) return;

      if (!this._speedLocked) {
        this.ditMs = estDit;
        this._speedLocked = true;
        this._dahDitRatio = clamp(dahDitRatio, 1.6, 4.5);
        this._replayPreBuffer();
        return;
      }

      const alpha = this._onDurations.length < 16 ? 0.22 : 0.08;
      const nextDit = this.ditMs * (1 - alpha) + estDit * alpha;
      this.ditMs = clamp(nextDit, 1200 / this.maxWpm, 1200 / this.minWpm);
      this._dahDitRatio = this._dahDitRatio * 0.85 + clamp(dahDitRatio, 1.6, 4.5) * 0.15;
    }

    _getGapThresholds() {
      const defaultCharGap = this.ditMs * 2.45;
      const defaultWordGap = this.ditMs * 5.5;
      const gaps = this._offDurations.filter(v => v >= this.ditMs * 0.45 && v <= this.ditMs * 12);
      if (gaps.length < 8) return { charGap: defaultCharGap, wordGap: defaultWordGap };

      const sorted = gaps.sort((a, b) => a - b);
      const boundaries = [];
      for (let i = 1; i < sorted.length; i++) {
        const ratio = sorted[i] / Math.max(1, sorted[i - 1]);
        if (ratio >= 1.3) boundaries.push({ ratio, i });
      }
      boundaries.sort((a, b) => b.ratio - a.ratio);
      if (!boundaries.length) return { charGap: defaultCharGap, wordGap: defaultWordGap };

      const indices = boundaries.slice(0, 2).map(b => b.i).sort((a, b) => a - b);
      const charGap = Math.sqrt(sorted[indices[0] - 1] * sorted[indices[0]]);
      let wordGap = defaultWordGap;
      if (indices.length > 1) wordGap = Math.sqrt(sorted[indices[1] - 1] * sorted[indices[1]]);

      return {
        charGap: charGap >= this.ditMs * 1.45 && charGap <= this.ditMs * 4.2 ? charGap : defaultCharGap,
        wordGap: wordGap >= this.ditMs * 4.6 && wordGap > charGap * 1.7 ? wordGap : defaultWordGap,
      };
    }

    _replayPreBuffer() {
      const buffered = this._preBuffer.slice();
      this._preBuffer = [];
      this.symbol = '';
      this.text = '';
      for (const entry of buffered) {
        if (entry.type === 'on') this._processOnDuration(entry.duration);
        else this._classifyGap(entry.duration);
      }
    }
  }

  class CwSignalGate {
    constructor(opts = {}) {
      this.attackMs = opts.attackMs || 8;
      this.releaseMs = opts.releaseMs || 32;
      this.reset();
    }

    reset() {
      this.state = false;
      this.candidate = null;
      this.candidateMs = 0;
    }

    process(rawKeyed, dtMs) {
      rawKeyed = !!rawKeyed;
      dtMs = Math.max(1, Number(dtMs) || 1);
      const out = [];

      if (rawKeyed === this.state) {
        if (this.candidate !== null) {
          out.push({ keyed: this.state, dtMs: this.candidateMs });
          this.candidate = null;
          this.candidateMs = 0;
        }
        out.push({ keyed: this.state, dtMs });
        return out;
      }

      if (this.candidate !== rawKeyed) {
        this.candidate = rawKeyed;
        this.candidateMs = 0;
      }
      this.candidateMs += dtMs;

      const threshold = rawKeyed ? this.attackMs : this.releaseMs;
      if (this.candidateMs < threshold) return out;

      const oldMs = Math.min(this.candidateMs, threshold * 0.5);
      const newMs = this.candidateMs - oldMs;
      if (oldMs > 0) out.push({ keyed: this.state, dtMs: oldMs });
      this.state = rawKeyed;
      if (newMs > 0) out.push({ keyed: this.state, dtMs: newMs });
      this.candidate = null;
      this.candidateMs = 0;
      return out;
    }
  }

  return { CwDecoderCore, CwSignalGate, MORSE };
});
