const assert = require('assert');
const { CwDecoderCore, CwSignalGate, MORSE } = require('../renderer/cw-decoder-core');

const REVERSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

function feedMessage(decoder, message, wpm = 20) {
  const dit = 1200 / wpm;
  decoder.setWpm(wpm);

  const key = (on, units) => decoder.processKeyed(on, dit * units);
  for (const rawCh of message.toUpperCase()) {
    if (rawCh === ' ') {
      key(false, 7);
      continue;
    }
    const code = REVERSE[rawCh];
    assert.ok(code, `No Morse mapping for ${rawCh}`);
    for (let i = 0; i < code.length; i++) {
      key(true, code[i] === '.' ? 1 : 3);
      key(false, i === code.length - 1 ? 3 : 1);
    }
  }
  key(false, 8);
  decoder.flush();
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('decodes CQ TEST timing stream', () => {
  const decoder = new CwDecoderCore();
  feedMessage(decoder, 'CQ TEST', 22);
  assert.strictEqual(decoder.text.trim(), 'CQ TEST');
});

test('adapts WPM estimate from mark lengths', () => {
  const decoder = new CwDecoderCore();
  feedMessage(decoder, 'VVV', 28);
  assert.ok(decoder.wpm >= 24 && decoder.wpm <= 32, `WPM estimate was ${decoder.wpm}`);
});

test('signal gate ignores short dropouts inside a dash', () => {
  const decoder = new CwDecoderCore();
  const gate = new CwSignalGate({ attackMs: 8, releaseMs: 32 });
  decoder.setWpm(20);

  const feed = (keyed, ms) => {
    for (const segment of gate.process(keyed, ms)) {
      decoder.processKeyed(segment.keyed, segment.dtMs);
    }
  };

  feed(true, 80);
  feed(false, 12);
  feed(true, 92);
  feed(false, 260);
  decoder.flush();

  assert.strictEqual(decoder.text.trim(), 'T');
});

let passed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`✓ ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${t.name}`);
    console.error(err && err.stack || err);
    process.exitCode = 1;
  }
}

console.log(`\nCW decoder core: ${passed}/${tests.length} passed`);
