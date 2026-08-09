#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Extract the JSC dense-coding word table from JS8Call's JSC_map.cpp into
// assets/js8-jsc-map.json (an array of 262144 words, in codeword-index
// order — map[j] is the word for index j, which is exactly the layout
// JSC::decompress consumes).
//
// Run against a JS8Call-improved checkout:
//   node scripts/extract-js8-jsc-table.js <path-to-js8call-src>
//
// The output is checked in; this script exists so a future upstream table
// refresh is reproducible, not archaeology.
'use strict';

const fs = require('fs');
const path = require('path');

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('usage: node scripts/extract-js8-jsc-table.js <js8call-src>');
  process.exit(2);
}

const cpp = fs.readFileSync(path.join(srcRoot, 'JS8_JSC', 'JSC_map.cpp'), 'latin1');

// Entries look like: {"WORD", 4, 12345},  — with C escapes in the string,
// and occasionally an annotation comment between the string and the counts:
//   {"\xa1" /* ¡ - "BO60" */, 1, 10704}
// The comment is matched non-greedily AFTER the closing quote, so a data
// word containing "/*" (inside quotes) can never confuse it.
const re = /\{\s*"((?:[^"\\]|\\.)*)"\s*(?:\/\*.*?\*\/\s*)?,\s*(\d+)\s*,\s*(\d+)\s*\}/g;
const words = [];
let m;
while ((m = re.exec(cpp))) {
  const raw = m[1];
  const size = parseInt(m[2], 10);
  const index = parseInt(m[3], 10);
  // Undo C escapes. The table uses \" \\ and octal/hex rarely; handle all.
  const word = raw.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, esc) => {
    if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    const map = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
    return map[esc] !== undefined ? map[esc] : esc;
  });
  // size is the MATCH length the C++ lookup/compress consume — usually
  // strlen, but not always ("@ALLCALL" ships with size 7). That asymmetry
  // is on-air protocol behavior; preserve it, don't "fix" it.
  words[index] = word.length === size ? word : [word, size];
}

if (words.length !== 262144) {
  console.error(`expected 262144 entries, got ${words.length}`);
  process.exit(1);
}
for (let i = 0; i < words.length; i++) {
  if (words[i] === undefined) {
    console.error(`hole at index ${i}`);
    process.exit(1);
  }
}

const out = path.join(__dirname, '..', 'assets', 'js8-jsc-map.json');
fs.writeFileSync(out, JSON.stringify(words));
console.log(`wrote ${out}: ${words.length} words, ${fs.statSync(out).size} bytes`);
