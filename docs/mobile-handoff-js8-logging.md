# Mobile Handoff — JS8 QSO logging + WSPR daily counters

**Audience:** POTACAT mobile (iOS / Android) team
**Scope:** Two additions to contracts you already implement: logging a JS8
conversation as a QSO from the thread view, and rendering the WSPR daily
counters now riding `wspr-session`.
**ALL desktop work is BUILT (2026-08-09).**
**Origin:** Casey (K3SBP): JS8 QSO logging on desktop and mobile; counting
WSPR decodes and reporting submissions per day "and logging it somewhere."

---

## 1. JS8 QSO logging

### The model

The conversation IS the QSO record. There is no auto-logger — JS8 is a
ragchew mode — so logging is a deliberate tap in the thread view, and the
HOST extracts the exchange into a prefill. One extraction implementation
(`lib/js8-qso.js`, pure + tested) feeds both the desktop Log window and
your log form, so the two can never disagree about what a thread said.

What the extraction does (so you can explain the prefill to the user):

- **Reports go the right directions.** `rstRcvd` = the SNR THEY reported
  of us (their `SNR -12` message); `rstSent` = the report WE sent, falling
  back to the best SNR we decoded them at (what we would honestly report).
  Empty when the exchange carried none — never invented.
- **Times come from the latest exchange.** A thread can span days; a gap
  over 30 minutes splits sessions and the prefill covers only the trailing
  one (`timeOn`/`timeOff` HHMMSS + `qsoDate` YYYYMMDD, all UTC).
- **Grid** prefers the heard rail's heartbeat capture over a word in the
  text that happened to look like a grid.
- **Frequency** = dial + the last audio offset, kHz.
- ADIF on the host writes `MODE=MFSK, SUBMODE=JS8` (bare `MODE=JS8` is
  rejected by LoTW — fixed on the desktop as part of this work).

### Wire contract

```json
C2S: { "type": "js8-log-prefill", "id": "KN4CRD", "reqId": "L1" }
S2C: { "type": "js8-log-prefill", "id": "KN4CRD",
       "prefill": { "callsign": "KN4CRD", "grid": "EM73",
                    "rstSent": "-05", "rstRcvd": "-12",
                    "timeOn": "143000", "timeOff": "143630",
                    "qsoDate": "20260809", "freqKhz": 14079.5,
                    "mode": "JS8", "submode": "NORMAL", "messages": 7 } }
```

- `prefill` is `null` with an `error` string when there is nothing to log
  (empty thread; group threads are nets, not QSOs — don't offer the button
  on them).
- **Submit through your existing `log-qso` channel**, exactly as you log
  today: your uuid, the cloud dupe-merge, session-contacts — all of it
  applies unchanged. This message only PREFILLS; it never writes.
- **Guest Pass: refused** (`js8-send-result {ok:false}` with your `reqId`)
  — logging writes the owner's logbook, and the prefill would read a DM.
  Hide the Log affordance in pass sessions.

### UX expectation

A Log action in the (non-group) thread view. Prefill lands → your log form
opens with it → user confirms/edits → existing submit. If `rstSent` or
`rstRcvd` is empty, leave the field empty for the user rather than
inventing 599 — the desktop form now behaves the same way.

## 2. WSPR daily counters (`wspr-session.today`)

`wspr-session` gained an optional `today` object — the per-UTC-day rollup,
persisted on the desktop (`wspr-daily.json`, 400 days of history) and
updated as batches land:

```json
"today": { "date": "20260809", "decoded": 214, "uniqueCalls": 61,
           "bestDxMi": 4102, "bestDxCall": "VK2ABC",
           "uploadedWsprnet": 214, "sentPskr": 214 }
```

Render it as the header of your WSPR view: "today: 214 decodes · 61 calls
· best DX 4,102 mi · 214 → wsprnet · 214 → PSKReporter".

**One wording rule that is not optional:** `uploadedWsprnet` means
ACCEPTED (request/response); `sentPskr` means SENT — PSKReporter ingest is
fire-and-forget UDP with no acknowledgment, so never render "received by
PSKReporter". The field names carry the distinction on purpose.

Desktop behavior you can rely on: WSPR receptions now also go to
PSKReporter (same `pskrUpload` setting that gates FT8 reporting), the CAT
log prints a one-line day summary at UTC rollover and at session end, and
`today` may be absent on older desktops or before the first decode of the
day — treat absent as "nothing to show yet".

Desktop cross-references: `lib/js8-qso.js` + `test/js8-qso-test.js`
(extraction), `lib/wspr/daily.js` + `test/wspr-daily-test.js` (rollup),
`main.js` js8-log-prefill / pskrQueueWsprSpots / wsprDailyFold,
`docs/echocat-protocol.md` (registry prose).
