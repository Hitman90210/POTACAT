// Spot mute rules — "hide {continent} on {band}" (Ron N7BBQ 2026-08-03:
// daily 2100Z JA activators on 40m he can never work stop his scan, but a
// global Asia filter would also hide the 15m openings he CAN work).
//
// A rule is { continent: 'AS', band: '40m' } — strictly per-band; the
// existing global continent filters already cover the blanket case. Rules
// live in settings.spotMuteRules (desktop-owned), are applied in every spot
// filter pipeline (desktop table/map/scan inherit via getFiltered; ECHOCAT
// clients receive them inside the echo-filters payload and apply the same
// predicate), and MUST be visible wherever they apply — an invisible filter
// is a "where did my spots go" bug report.
//
// Dual-mode like lib/rig-family.js: require() from main, window.SpotMuteRules
// via <script> in the renderer.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotMuteRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // cty.dat continent codes → display names (JA is AS, not OC — the thread's
  // "is JA in Asia?" answer is yes).
  const CONTINENT_NAMES = {
    AF: 'Africa',
    AN: 'Antarctica',
    AS: 'Asia',
    EU: 'Europe',
    NA: 'North America',
    OC: 'Oceania',
    SA: 'South America',
  };

  const MAX_RULES = 50;

  /**
   * Sanitize a rules array from ANY source (settings.json, a client blob,
   * an import) — never store or apply a wire payload verbatim. Unknown
   * continents and empty bands are dropped, bands are lowercased to the
   * lib/bands.js token form ('40m'), duplicates collapse, length is capped.
   */
  function normalizeMuteRules(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const continent = String(r.continent || '').toUpperCase();
      const band = String(r.band || '').toLowerCase();
      if (!CONTINENT_NAMES[continent] || !band || band.length > 8) continue;
      const key = continent + '|' + band;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ continent, band });
      if (out.length >= MAX_RULES) break;
    }
    return out;
  }

  /** Does this spot match any mute rule? (Unknown-continent spots never
   *  match — a rule must not hide what it can't classify.) */
  function matchesMuteRule(spot, rules) {
    if (!spot || !rules || !rules.length) return false;
    const cont = String(spot.continent || '').toUpperCase();
    if (!cont) return false;
    const band = String(spot.band || '').toLowerCase();
    if (!band) return false;
    for (const r of rules) {
      if (r.continent === cont && r.band === band) return true;
    }
    return false;
  }

  /** "Asia on 40m" — chip/menu label. */
  function describeMuteRule(rule) {
    if (!rule) return '';
    return (CONTINENT_NAMES[rule.continent] || rule.continent) + ' on ' + rule.band;
  }

  return { CONTINENT_NAMES, normalizeMuteRules, matchesMuteRule, describeMuteRule, MAX_RULES };
});
