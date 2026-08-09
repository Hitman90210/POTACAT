// scripts/probe-flex.js — one-off diagnostic for POTACAT "Flex Direct" mode.
//
// Connects to a FlexRadio's SmartSDR TCP API on port 4992 with NO SmartSDR
// running, registers as a GUI client, then tests two ways to get a tunable
// slice and dumps every line the radio sends (timestamped). Used to verify
// the exact command sequence an 8600M expects before wiring "Flex Direct"
// mode into main.js / lib/smartsdr.js.
//
// Command syntax follows the official FlexRadio docs:
//   https://github.com/flexradio/smartsdr-api-docs/wiki
//   TCPIP-client / TCPIP-slice / TCPIP-display-panafall
//
// Usage:   node scripts/probe-flex.js [radioIP]
//          (default IP: 192.168.10.64)
//
// SAFE: it removes every slice + panafall it created and disconnects. Run
// with SmartSDR CLOSED. Throwaway diagnostic — delete once Flex Direct works.

const net = require('net');

const HOST = process.argv[2] || '192.168.10.64';
const PORT = 4992;

let seq = 1;
const pending = {};            // seq -> command string, to label R-responses
let buf = '';
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(2)}s]`;
const log = (...a) => console.log(stamp(), ...a);

// What we discover, so cleanup can tear it down.
let guiClientId = null;        // returned by `client gui`
let panStreamId = null;        // returned by `display panafall c`
const createdSlices = new Set(); // slice rx indices we created

// Seqs whose replies we parse specially.
let guiSeq = null;
let minSliceSeq = null;
let panafallSeq = null;
let panSliceSeq = null;
let finalListSeq = null;

const sock = new net.Socket();
sock.setNoDelay(true);

function send(cmd) {
  const s = seq++;
  pending[s] = cmd;
  log(`>> C${s}|${cmd}`);
  sock.write(`C${s}|${cmd}\n`);
  return s;
}

function handleLine(line) {
  if (!line) return;
  const r = line.match(/^R(\d+)\|/);
  if (r) {
    const rseq = r[1];
    const cmd = pending[rseq];
    log(`<< ${line}` + (cmd ? `      (reply to: ${cmd})` : ''));
    // R<seq>|<hexstatus>|<field2>|<field3>...
    const f = line.split('|');
    const status = f[1];
    const data = f[2] || '';

    if (rseq == guiSeq && status === '0') {
      guiClientId = data.trim();
      log(`   -> GUI client registered, client_id=${guiClientId}`);
    }
    // slice create reply: R21|0|2|OK Slice receiver 2 created ...
    if ((rseq == minSliceSeq || rseq == panSliceSeq)) {
      if (status === '0' && /^\d+$/.test(data.trim())) {
        createdSlices.add(data.trim());
        log(`   -> slice rx ${data.trim()} created (status 0)`);
      } else {
        log(`   -> slice create FAILED status=0x${status}`);
      }
    }
    // panafall create reply: R21|0|0x40000000,0x42000000
    if (rseq == panafallSeq) {
      const ids = data.match(/0x[0-9A-Fa-f]+/g) || [];
      panStreamId = ids[0] || null;
      log(`   -> panadapter=${ids[0]} waterfall=${ids[1]} (status 0x${status})`);
    }
    // final `slice list` reply: R41|0|0 1 3 4|
    if (rseq == finalListSeq && status === '0') {
      data.trim().split(/\s+/).filter(Boolean).forEach((n) => createdSlices.add(n));
      log(`   -> slice list reports active: ${data.trim() || '(none)'}`);
    }
    delete pending[rseq];
    return;
  }
  // Status / version / handle / everything else — verbatim.
  log(`<< ${line}`);
}

sock.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    handleLine(buf.slice(0, nl).replace(/\r$/, ''));
    buf = buf.slice(nl + 1);
  }
});
sock.on('error', (e) => log('SOCKET ERROR:', e.message));
sock.on('close', () => { log('socket closed'); process.exit(0); });

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

async function run() {
  log(`connecting to ${HOST}:${PORT} ...`);
  await new Promise((res) => sock.connect(PORT, HOST, res));
  log('connected — radio should send V<version> and H<handle> next');
  await wait(800);

  // 1. Become a GUI client. Omit client_id (v3.x: radio returns one to reuse).
  guiSeq = send('client gui');
  await wait(600);
  send('client program POTACAT-PROBE');
  send('client station PROBE');
  await wait(500);

  // 2. Subscribe to the streams Flex Direct mode will rely on.
  send('sub client all');
  send('sub slice all');
  send('sub pan all');
  send('sub tx all');
  log('--- waiting 2.5s to capture existing radio state ---');
  await wait(2500);

  // 3. TEST 1 — minimal path: a bare slice with no panadapter.
  //    Docs say pan= is optional. If this works, Flex Direct never needs a pan.
  log('=== TEST 1: bare slice create (no panadapter) ===');
  minSliceSeq = send('slice create freq=14.074 mode=USB');
  await wait(3000);
  for (const rx of createdSlices) {
    send(`slice tune ${rx} 14.250000`);
    send(`slice set ${rx} mode=CW`);
  }
  await wait(2000);

  // 4. TEST 2 — panafall path: pan + waterfall + (auto) slice, like SmartSDR.
  log('=== TEST 2: display panafall create ===');
  panafallSeq = send('display panafall create freq=14.100 x=100 y=100');
  await wait(3000);
  if (panStreamId) {
    panSliceSeq = send(`slice create freq=14.100 mode=USB pan=${panStreamId}`);
    await wait(2500);
  }

  // 5. Inventory everything before cleanup.
  send('slice list');
  finalListSeq = seq - 1;
  send('display pan list');
  await wait(2500);

  // 6. Clean up everything we created.
  log('=== CLEANUP ===');
  for (const rx of createdSlices) send(`slice remove ${rx}`);
  if (panStreamId) send(`display panafall remove ${panStreamId}`);
  await wait(2000);

  log('=== PROBE COMPLETE — copy this entire output back to Claude ===');
  sock.end();
  setTimeout(() => process.exit(0), 1000);
}

// Hard safety net so a hang never leaves our slice/pan on the radio.
setTimeout(() => {
  log('!! global timeout — forcing cleanup + exit');
  try {
    for (const rx of createdSlices) sock.write(`C${seq++}|slice remove ${rx}\n`);
    if (panStreamId) sock.write(`C${seq++}|display panafall remove ${panStreamId}\n`);
  } catch {}
  setTimeout(() => process.exit(1), 1500);
}, 35000);

run().catch((e) => { log('FATAL:', e.message); process.exit(1); });
