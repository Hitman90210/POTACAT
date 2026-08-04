// Preamp/ATT ladder resolver — the pure policy behind the cycling controls.
//
// KB2UXB (FT-710, 2026-08-04): "ATT goes off, or 6dB, but does not go to 12
// or 18. Preamp does exactly the same." POTACAT modeled a 3-4 position
// ladder as a boolean, so only the first ON step was reachable. These pin
// the ladder maths AND the boolean back-compat that keeps older ECHOCAT
// clients working.

const assert = require('assert');
const G = require('../lib/rig-gain-steps');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const PRE = G.YAESU_PREAMP_IPO_AMP1_AMP2;
const ATT = G.YAESU_ATT_6_12_18;

console.log('\n=== normalizeSteps ===');

test('a well-formed ladder passes through, sorted', () => {
  const out = G.normalizeSteps([{ v: 2, label: 'B' }, { v: 0, label: 'Off' }, { v: 1, label: 'A' }]);
  assert.deepStrictEqual(out.map((s) => s.v), [0, 1, 2]);
});

test('a ladder without an OFF step is rejected (never half-usable)', () => {
  assert.deepStrictEqual(G.normalizeSteps([{ v: 1 }, { v: 2 }]), []);
});

test('single-entry / empty / non-array declarations are rejected', () => {
  assert.deepStrictEqual(G.normalizeSteps([{ v: 0 }]), []);
  assert.deepStrictEqual(G.normalizeSteps([]), []);
  assert.deepStrictEqual(G.normalizeSteps(undefined), []);
  assert.deepStrictEqual(G.normalizeSteps('6,12'), []);
});

test('duplicate and negative values are dropped', () => {
  const out = G.normalizeSteps([{ v: 0 }, { v: 6 }, { v: 6 }, { v: -3 }]);
  assert.deepStrictEqual(out.map((s) => s.v), [0, 6]);
});

test('short label defaults strip the dB suffix', () => {
  const out = G.normalizeSteps([{ v: 0, label: 'Off' }, { v: 12, label: '12 dB' }]);
  assert.strictEqual(out[1].short, '12');
});

console.log('\n=== resolveStep — boolean back-compat ===');

test('true resolves to the FIRST ON step (old clients keep working)', () => {
  assert.strictEqual(G.resolveStep(true, PRE), 1);
  assert.strictEqual(G.resolveStep(true, ATT), 1);
});

test('false resolves to off', () => {
  assert.strictEqual(G.resolveStep(false, PRE), 0);
  assert.strictEqual(G.resolveStep(false, ATT), 0);
});

test('no ladder: true/false stay a plain 1/0 toggle', () => {
  assert.strictEqual(G.resolveStep(true, []), 1);
  assert.strictEqual(G.resolveStep(false, []), 0);
  assert.strictEqual(G.resolveStep(3, []), 1); // truthy request, no ladder = on
});

console.log('\n=== resolveStep — numeric steps ===');

test('an exact step passes through', () => {
  assert.strictEqual(G.resolveStep(2, PRE), 2);
  assert.strictEqual(G.resolveStep(3, ATT), 3);
});

test('0 and negatives are off', () => {
  assert.strictEqual(G.resolveStep(0, ATT), 0);
  assert.strictEqual(G.resolveStep(-1, ATT), 0);
});

test('an out-of-range step snaps to the nearest — never sent raw to the radio', () => {
  assert.strictEqual(G.resolveStep(9, PRE), 2);   // ladder tops out at AMP2
  assert.strictEqual(G.resolveStep(99, ATT), 3);
});

test('a dB ladder snaps to the nearest declared dB', () => {
  const db = G.stepsFromDbList([10, 20]);
  assert.strictEqual(G.resolveStep(12, db), 10);
  assert.strictEqual(G.resolveStep(18, db), 20);
  assert.strictEqual(G.resolveStep(20, db), 20);
});

test('garbage resolves to off, not to a random step', () => {
  assert.strictEqual(G.resolveStep(NaN, ATT), 0);
  assert.strictEqual(G.resolveStep(undefined, ATT), 0);
  assert.strictEqual(G.resolveStep('nonsense', ATT), 0);
});

console.log('\n=== nextStep — the cycle behind one button ===');

test('preamp cycles IPO -> AMP1 -> AMP2 -> IPO', () => {
  assert.strictEqual(G.nextStep(0, PRE), 1);
  assert.strictEqual(G.nextStep(1, PRE), 2);
  assert.strictEqual(G.nextStep(2, PRE), 0); // wraps back to off
});

test('attenuator reaches 12 and 18 — the KB2UXB bug, pinned', () => {
  assert.strictEqual(G.nextStep(0, ATT), 1);
  assert.strictEqual(G.nextStep(1, ATT), 2);
  assert.strictEqual(G.nextStep(2, ATT), 3);
  assert.strictEqual(G.nextStep(3, ATT), 0);
});

test('a full cycle visits every step exactly once', () => {
  const seen = [];
  let v = 0;
  for (let i = 0; i < ATT.length; i++) { seen.push(v); v = G.nextStep(v, ATT); }
  assert.deepStrictEqual(seen, [0, 1, 2, 3]);
  assert.strictEqual(v, 0, 'returns to off after the last step');
});

test('no ladder: nextStep is a plain toggle', () => {
  assert.strictEqual(G.nextStep(false, []), 1);
  assert.strictEqual(G.nextStep(true, []), 0);
});

test('a boolean current position still advances (mixed-vintage state)', () => {
  assert.strictEqual(G.nextStep(true, ATT), 2);  // true = step 1 -> next is 2
  assert.strictEqual(G.nextStep(false, ATT), 1);
});

console.log('\n=== labels ===');

test('stepLabel names the position', () => {
  assert.strictEqual(G.stepLabel(2, PRE), 'AMP2');
  assert.strictEqual(G.stepLabel(3, ATT), '18 dB');
  assert.strictEqual(G.stepLabel(7, ATT), '', 'unknown value has no label');
});

test('buttonLabel shows the base alone when off, base+step when on', () => {
  assert.strictEqual(G.buttonLabel('Att', 0, ATT), 'Att');
  assert.strictEqual(G.buttonLabel('Att', 2, ATT), 'Att 12');
  assert.strictEqual(G.buttonLabel('Pre', 2, PRE), 'Pre 2');
  assert.strictEqual(G.buttonLabel('Pre', 1, []), 'Pre', 'no ladder = plain label');
});

console.log('\n=== stepsFromDbList (hamlib dump_caps) ===');

test('a probed dB list becomes a ladder with OFF prepended', () => {
  assert.deepStrictEqual(G.stepsFromDbList([6, 12]).map((s) => s.v), [0, 6, 12]);
  assert.strictEqual(G.stepsFromDbList([6, 12])[2].label, '12 dB');
});

test('probed lists are de-duped and sorted', () => {
  assert.deepStrictEqual(G.stepsFromDbList([20, 10, 20]).map((s) => s.v), [0, 10, 20]);
});

test('an empty or garbage probe yields no ladder (falls back to on/off)', () => {
  assert.deepStrictEqual(G.stepsFromDbList([]), []);
  assert.deepStrictEqual(G.stepsFromDbList([0]), []);
  assert.deepStrictEqual(G.stepsFromDbList(null), []);
});

console.log('\n' + '='.repeat(60));
if (failures) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('All rig-gain-steps tests passed.');
