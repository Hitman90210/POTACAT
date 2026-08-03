// scripts/probe-flex-txdax.js — isolated verification for the bound-mode
// dead-carrier fix (transmit set dax=).
//
// The radio transmits POTACAT's direct VITA-49 dax_tx audio only while the
// transmit `dax=` switch is 1 for the relevant STATION. Probe run 2026-08-03
// established two facts on the 8600 (v4.2.x):
//   - dax=0 while self-mode FT8 modulates fine → a GUI client's OWN direct
//     dax_tx stream doesn't need the flag; it matters for the bound case.
//   - an UNBOUND non-GUI client's `transmit set dax=1` is silently ignored
//     (radio re-broadcast dax=0) → transmit config is per-station; the set
//     must come from a client-bound connection. POTACAT's fix sends it on
//     the audio connection, which is always bound.
//
// Modes (default IP 192.168.10.64):
//   node scripts/probe-flex-txdax.js [ip]                # read-only: report dax=
//   node scripts/probe-flex-txdax.js [ip] --flip         # set/restore, UNBOUND (expected: ignored)
//   node scripts/probe-flex-txdax.js [ip] --flip --bind  # bind to a discovered GUI client
//                                                        # first — models POTACAT's audio
//                                                        # connection exactly
//
// --bind needs a GUI client on the radio: POTACAT running (self mode) counts,
// so does SmartSDR / AetherSDR being open.
//
// SAFE: takes no GUI slot, touches no slice, never keys. --flip restores the
// original value before exiting.

const net = require('net');

const args = process.argv.slice(2);
const HOST = (args[0] && !args[0].startsWith('--')) ? args[0] : '192.168.10.64';
const FLIP = args.includes('--flip');
// --set 0|1 (or --set=0): set dax to that value and EXIT — no restore. For
// staging the dead-carrier precondition (dax=0) before an attended TX test.
// Implies --bind (an unbound set is ignored).
let SETVAL = null;
const setIdx = args.findIndex((a) => a === '--set' || a.startsWith('--set='));
if (setIdx !== -1) {
  const raw = args[setIdx].includes('=') ? args[setIdx].split('=')[1] : args[setIdx + 1];
  if (raw === '0' || raw === '1') SETVAL = raw;
  else { console.error('--set requires 0 or 1'); process.exit(2); }
}
const BIND = args.includes('--bind') || SETVAL != null;
const PORT = 4992;

let seq = 1;
const pending = {};   // seq -> command, to label R replies
let buf = '';
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(2)}s]`;
const log = (...a) => console.log(stamp(), ...a);

const sock = new net.Socket();
sock.setNoDelay(true);

function send(cmd) {
  const s = seq++;
  pending[s] = cmd;
  log(`>> C${s}|${cmd}`);
  sock.write(`C${s}|${cmd}\n`);
  return s;
}

// Phases: (bind: discover -> bound) -> read -> flipped -> restored
let phase = BIND ? 'discover' : 'read';
let bindSeq = null;
let flipSeq = null;
const guiClients = [];   // client_id UUIDs seen in client-connected statuses
let originalDax = null;
let sawDax = false;
let done = false;

function finish(code, msg) {
  if (done) return;
  done = true;
  log(msg);
  try { sock.destroy(); } catch {}
  process.exit(code);
}

setTimeout(() => {
  if (phase === 'discover') return finish(1, 'TIMEOUT — no GUI client discovered to bind to. Start POTACAT (self mode) or open SmartSDR/AetherSDR, then re-run --bind.');
  if (!sawDax) return finish(1, 'TIMEOUT — no transmit status with dax= seen. Capture this output.');
  if (phase === 'flipped') return finish(1, `TIMEOUT — the radio never echoed the flipped value; the set was IGNORED from this ${BIND ? 'BOUND (unexpected — capture this!)' : 'unbound (expected: per-station config)'} context. Last seen dax=${originalDax}.`);
  if (phase === 'restored') return finish(1, 'TIMEOUT waiting for the restore echo — check the radio; original value was dax=' + originalDax + '.');
  finish(1, 'TIMEOUT in phase ' + phase);
}, 12000);

function startRead() {
  phase = 'read';
  send('sub tx all'); // delivers one full transmit status immediately
}

function onTransmitStatus(kv) {
  if (kv.dax == null) return;
  sawDax = true;
  if (phase === 'read') {
    originalDax = kv.dax;
    log(`RESULT: transmit dax=${kv.dax}  (${kv.dax === '1' ? 'DAX TX stream is the TX audio source' : 'mic is the TX audio source'})`);
    if (SETVAL != null) {
      if (kv.dax === SETVAL) return finish(0, `Already dax=${SETVAL} — nothing to do.`);
      phase = 'flipped';
      log(`Setting (BOUND, no restore): transmit set dax=${SETVAL}`);
      flipSeq = send(`transmit set dax=${SETVAL}`);
      return;
    }
    if (!FLIP) return finish(0, 'Read-only probe complete.');
    phase = 'flipped';
    const target = originalDax === '1' ? 0 : 1;
    log(`Flipping (${BIND ? 'BOUND' : 'unbound'}): transmit set dax=${target} (will restore to ${originalDax})`);
    flipSeq = send(`transmit set dax=${target}`);
  } else if (phase === 'flipped') {
    if (SETVAL != null) {
      if (kv.dax !== SETVAL) return;
      return finish(0, `SET CONFIRMED: dax=${SETVAL} (left in place — no restore). Run the TX test now.`);
    }
    const expected = originalDax === '1' ? '0' : '1';
    if (kv.dax !== expected) {
      log(`   (radio re-broadcast dax=${kv.dax} — set not applied${BIND ? '' : ', consistent with unbound being ignored'})`);
      return;
    }
    log(`CONFIRMED: radio echoed dax=${kv.dax} after set — the flag IS settable from this context`);
    phase = 'restored';
    log(`Restoring: transmit set dax=${originalDax}`);
    send(`transmit set dax=${originalDax}`);
  } else if (phase === 'restored') {
    if (kv.dax !== originalDax) return;
    finish(0, `CONFIRMED: restored to dax=${originalDax}. No TX occurred.`);
  }
}

function handleLine(line) {
  if (!line) return;

  // R replies — log ALL of them, labeled with the command they answer.
  const r = line.match(/^R(\d+)\|([0-9A-Fa-f]+)\|?(.*)$/);
  if (r) {
    const cmd = pending[r[1]];
    const isProgErr = /unknown client program/.test(r[3] || '');
    log(`<< R${r[1]}|${r[2]}${r[3] ? '|' + r[3] : ''}${cmd ? `   (reply to: ${cmd})` : ''}${isProgErr ? '   [harmless — radio doesn\'t recognize the program name]' : ''}`);
    if (bindSeq != null && r[1] === String(bindSeq)) {
      bindSeq = null;
      if (r[2] === '0') {
        log('BOUND — this connection now has the GUI client\'s station context (same as POTACAT\'s audio connection).');
        startRead();
      } else {
        finish(1, `client bind FAILED (status 0x${r[2]}). Capture this output.`);
      }
    }
    if (flipSeq != null && r[1] === String(flipSeq) && r[2] !== '0') {
      log(`   NOTE: the set itself was REJECTED (status 0x${r[2]}) — stronger than silently ignored.`);
    }
    return;
  }

  // Client-connected statuses — collect GUI client ids for --bind.
  const idMatch = line.match(/\|client 0x[0-9A-Fa-f]+ connected .*client_id=([0-9A-Fa-f-]{8,})/);
  if (idMatch && phase === 'discover') {
    if (!guiClients.includes(idMatch[1])) {
      guiClients.push(idMatch[1]);
      log(`<< GUI client discovered: ${idMatch[1]}   (${(line.match(/program=(\S+)/) || [])[1] || 'unknown program'})`);
    }
    return;
  }

  const m = line.match(/\|transmit (.+)$/);
  if (m) {
    const kv = {};
    for (const part of m[1].split(' ')) {
      const eq = part.indexOf('=');
      if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
    }
    log(`<< transmit status: ${m[1]}`);
    onTransmitStatus(kv);
  }
}

sock.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    handleLine(buf.slice(0, nl).trim());
    buf = buf.slice(nl + 1);
  }
});

sock.on('error', (err) => finish(1, `SOCKET ERROR: ${err.message}`));
sock.on('close', () => finish(1, 'Socket closed by radio.'));

log(`Connecting to ${HOST}:${PORT} (${BIND ? 'bind-then-' : ''}${FLIP ? 'flip+restore' : 'read-only'})...`);
sock.connect(PORT, HOST, () => {
  log('Connected.');
  send('client program POTACAT-txdax-probe');
  if (BIND) {
    send('sub client all');
    // Give discovery a beat, then bind to the first GUI client seen.
    setTimeout(() => {
      if (done) return;
      if (!guiClients.length) return; // overall timeout will explain
      bindSeq = send(`client bind client_id=${guiClients[0]}`);
    }, 1500);
  } else {
    startRead();
  }
});
