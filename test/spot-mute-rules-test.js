#!/usr/bin/env node
'use strict';
// Per-band region mute rules (N7BBQ). Run: node test/spot-mute-rules-test.js

const assert = require('assert');
const { normalizeMuteRules, matchesMuteRule, describeMuteRule, MAX_RULES } = require('../lib/spot-mute-rules');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

check('normalize: valid rule passes, case is canonicalized', () => {
  assert.deepStrictEqual(
    normalizeMuteRules([{ continent: 'as', band: '40M' }]),
    [{ continent: 'AS', band: '40m' }]);
});

check('normalize: unknown continent, empty band, junk entries dropped', () => {
  assert.deepStrictEqual(normalizeMuteRules([
    { continent: 'XX', band: '40m' },
    { continent: 'AS', band: '' },
    null, 'nope', 42,
    { continent: 'EU', band: '20m' },
  ]), [{ continent: 'EU', band: '20m' }]);
});

check('normalize: duplicates collapse, non-array input yields []', () => {
  assert.strictEqual(normalizeMuteRules([{ continent: 'AS', band: '40m' }, { continent: 'AS', band: '40m' }]).length, 1);
  assert.deepStrictEqual(normalizeMuteRules(null), []);
  assert.deepStrictEqual(normalizeMuteRules('AS'), []);
});

check('normalize: length capped at MAX_RULES', () => {
  const many = [];
  for (let i = 0; i < 100; i++) many.push({ continent: 'AS', band: i + 'm' });
  assert.strictEqual(normalizeMuteRules(many).length, MAX_RULES);
});

check('match: JA-style spot (AS continent) hidden on 40m only — the N7BBQ case', () => {
  const rules = normalizeMuteRules([{ continent: 'AS', band: '40m' }]);
  assert.strictEqual(matchesMuteRule({ continent: 'AS', band: '40m' }, rules), true);
  assert.strictEqual(matchesMuteRule({ continent: 'AS', band: '15m' }, rules), false); // 15m stays visible
  assert.strictEqual(matchesMuteRule({ continent: 'OC', band: '40m' }, rules), false); // JA is AS, not OC
});

check('match: unknown-continent spots never match (cannot hide what we cannot classify)', () => {
  const rules = normalizeMuteRules([{ continent: 'AS', band: '40m' }]);
  assert.strictEqual(matchesMuteRule({ continent: '', band: '40m' }, rules), false);
  assert.strictEqual(matchesMuteRule({ band: '40m' }, rules), false);
  assert.strictEqual(matchesMuteRule({ continent: 'AS' }, rules), false);
});

check('match: case-insensitive against spot fields', () => {
  const rules = normalizeMuteRules([{ continent: 'AS', band: '40m' }]);
  assert.strictEqual(matchesMuteRule({ continent: 'as', band: '40M' }, rules), true);
});

check('match: empty rules match nothing', () => {
  assert.strictEqual(matchesMuteRule({ continent: 'AS', band: '40m' }, []), false);
  assert.strictEqual(matchesMuteRule({ continent: 'AS', band: '40m' }, null), false);
});

check('describe: "Asia on 40m"', () => {
  assert.strictEqual(describeMuteRule({ continent: 'AS', band: '40m' }), 'Asia on 40m');
  assert.strictEqual(describeMuteRule({ continent: 'NA', band: '20m' }), 'North America on 20m');
});

console.log(`\nspot-mute-rules: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
