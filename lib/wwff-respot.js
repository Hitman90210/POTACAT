// WWFF Spotline telnet re-spotter — one-shot DX spot via DXSpider at spots.wwff.co:7300
//
// NOTE (2026-07-25, N4RDX): spots.wwff.co:7300 became a READ-ONLY feed — it
// still streams spots (login prompt + banner) but no longer accepts telnet DX
// submissions, so the post-login '>' prompt this state machine waits for never
// arrives and every re-spot hit the 10 s timeout with a confusing "timed out".
// We now detect the "read-only" banner and fail fast with an actionable message.
// Restoring real WWFF re-spotting needs the Spotline web API (spots.wwff.co),
// which requires an API key requested from WWFF (Jouni OH3CUF, cuf.fi).
const net = require('net');

const WWFF_HOST = 'spots.wwff.co';
const WWFF_PORT = 7300;
const TIMEOUT = 10000;
// The server's own banner text when it won't accept submissions.
const READ_ONLY_RE = /read-?only/i;
const READ_ONLY_MSG = 'WWFF telnet spotting is read-only now — spot manually at spots.wwff.co/spots/create';
// Latched once the server announces it's read-only, so we don't reconnect and
// re-detect on every subsequent dual POTA+WWFF log — after the first, fail
// instantly with no socket and no delay on the QSO save.
let _knownReadOnly = false;

/**
 * Post a re-spot to WWFF Spotline via telnet.
 * @param {Object} opts
 * @param {string} opts.activator  — activator callsign
 * @param {string} opts.spotter    — your callsign (login)
 * @param {string} opts.frequency  — frequency in kHz (string or number)
 * @param {string} opts.reference  — WWFF reference e.g. "VEFF-3789"
 * @param {string} opts.mode       — mode e.g. "SSB"
 * @param {string} [opts.comments] — optional comment
 * @returns {Promise<void>}
 */
function postWwffRespot({ activator, spotter, frequency, reference, mode, comments }) {
  return new Promise((resolve, reject) => {
    // Known read-only from an earlier attempt — fail instantly, don't connect.
    if (_knownReadOnly) return reject(new Error(READ_ONLY_MSG));
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve();
    };

    const sock = net.createConnection({ host: WWFF_HOST, port: WWFF_PORT }, () => {
      // Connected — wait for login prompt
    });

    const timer = setTimeout(() => finish(new Error('WWFF respot timed out')), TIMEOUT);

    let buf = '';
    let state = 'login'; // login -> prompt -> done

    sock.on('data', (chunk) => {
      buf += chunk.toString();

      // Read-only server: it will never give us a submission prompt, so bail
      // immediately with a clear reason instead of waiting out the timeout, and
      // latch it so the next re-spot fails instantly.
      if (READ_ONLY_RE.test(buf)) {
        _knownReadOnly = true;
        clearTimeout(timer);
        return finish(new Error(READ_ONLY_MSG));
      }

      if (state === 'login' && /login:|call:|Please enter your call/i.test(buf)) {
        state = 'prompt';
        buf = '';
        sock.write(spotter + '\r\n');
      } else if (state === 'prompt' && />\s*$/.test(buf)) {
        state = 'done';
        buf = '';
        const freqKhz = Math.round(parseFloat(frequency));
        const comment = [reference, mode, comments].filter(Boolean).join(' ');
        sock.write(`DX ${freqKhz} ${activator} ${comment}\r\n`);
        // Brief delay to let server acknowledge, then close
        setTimeout(() => {
          clearTimeout(timer);
          finish();
        }, 1500);
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    sock.on('close', () => {
      clearTimeout(timer);
      finish(); // treat close as success if not already settled
    });
  });
}

module.exports = { postWwffRespot };
