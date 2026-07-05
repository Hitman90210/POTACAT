// Lightweight CW decoder core for the VFO popout.
//
// This is intentionally small and dependency-free. The audio/UI layer feeds it
// one keyed/unkeyed decision per frame; this class handles timing adaptation
// and Morse symbol decoding.
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
    '.-.-.-': '.', '--..--': ',', '..--..': '?', '-..-.': '/',
    '-....-': '-', '-.--.': '(', '-.--.-': ')', '.-.-.': '+',
    '-...-': '=', '.--.-.': '@',
  };

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  class CwDecoderCore {
    constructor(opts = {}) {
      this.minWpm = opts.minWpm || 5;
      this.maxWpm = opts.maxWpm || 45;
      this.reset();
    }

    reset() {
      this.ditMs = 1200 / 18;
      this.state = false;
      this.stateMs = 0;
      this.haveState = false;
      this.symbol = '';
      this.text = '';
      this.events = [];
      this._charFlushedForSpace = false;
      this._wordFlushedForSpace = false;
      this._recentUnits = [];
    }

    get wpm() {
      return Math.round(1200 / this.ditMs);
    }

    setWpm(wpm) {
      const clamped = clamp(Number(wpm) || 18, this.minWpm, this.maxWpm);
      this.ditMs = 1200 / clamped;
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
      if (this.state) this._finishMark(elapsed);
      else this._finishSpace(elapsed);

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
      if (this.symbol) this._flushChar();
      return this.events;
    }

    _finishMark(ms) {
      if (ms < 15) return;
      const unit = ms < this.ditMs * 2.2 ? 1 : 3;
      this.symbol += unit === 1 ? '.' : '-';
      this._learnDit(ms / unit);
      this.events.push({ type: 'mark', value: unit === 1 ? 'dit' : 'dah', ms });
    }

    _finishSpace(ms) {
      if (!this.symbol) return;
      if (ms >= this.ditMs * 6.2) {
        this._flushChar();
        this._appendSpace();
      } else if (ms >= this.ditMs * 2.4) {
        this._flushChar();
      }
    }

    _maybeFlushOngoingSpace() {
      if (!this.symbol) return;
      if (!this._charFlushedForSpace && this.stateMs >= this.ditMs * 3.2) {
        this._flushChar();
        this._charFlushedForSpace = true;
      }
      if (!this._wordFlushedForSpace && this.stateMs >= this.ditMs * 7.0) {
        this._appendSpace();
        this._wordFlushedForSpace = true;
      }
    }

    _flushChar() {
      const code = this.symbol;
      const ch = MORSE[code] || '·';
      this.text += ch;
      this.events.push({ type: 'char', code, char: ch, text: this.text });
      this.symbol = '';
    }

    _appendSpace() {
      if (!this.text || this.text.endsWith(' ')) return;
      this.text += ' ';
      this.events.push({ type: 'space', text: this.text });
    }

    _learnDit(unitMs) {
      if (!Number.isFinite(unitMs)) return;
      const minDit = 1200 / this.maxWpm;
      const maxDit = 1200 / this.minWpm;
      if (unitMs < minDit * 0.55 || unitMs > maxDit * 1.6) return;
      this._recentUnits.push(unitMs);
      if (this._recentUnits.length > 24) this._recentUnits.shift();
      const sorted = this._recentUnits.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      this.ditMs = this.ditMs * 0.82 + median * 0.18;
      this.ditMs = clamp(this.ditMs, minDit, maxDit);
    }
  }

  return { CwDecoderCore, MORSE };
});
