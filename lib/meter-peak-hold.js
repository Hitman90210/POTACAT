'use strict';
// Peak-hold for a sampled wattmeter (pure; test/lz3aw-round8-test.js).
//
// A CAT wattmeter is one instantaneous sample per poll: in CW it often lands
// between elements, in SSB on a syllable's tail, so a display that draws each
// sample reads well under the radio's own bar, which is peak-reading (LZ3AW,
// TS-480: "the meter is not so dynamic as on the radio"). The display jumps
// straight up to any new peak, holds it for holdMs, then decays toward the
// live reading at decayPerSec (a fraction per second) — never below it.

function createPeakHold({ holdMs = 1000, decayPerSec = 0.5 } = {}) {
  let peakW = 0;
  let peakAt = 0;
  return {
    /** Feed a sample; returns the value to display. */
    sample(w, now = Date.now()) {
      const live = Math.max(0, Number(w) || 0);
      const age = now - peakAt;
      const held = age <= holdMs ? peakW : peakW * Math.pow(1 - decayPerSec, (age - holdMs) / 1000);
      if (live >= held) { peakW = live; peakAt = now; return live; }
      return Math.round(held * 10) / 10;
    },
    reset() { peakW = 0; peakAt = 0; },
  };
}

module.exports = { createPeakHold };
