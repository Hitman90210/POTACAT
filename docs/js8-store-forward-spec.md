# Spec — JS8 store-and-forward (inbox, relay, and the mail-drop network)

**Status:** SPEC — not built. Prereqs shipped: the full directed-command
vocabulary in `lib/js8-varicode.js` (`MSG TO:` 10, `QUERY` 11, `QUERY MSGS`
12, `QUERY CALL` 13, checksum/buffered-command metadata), `Js8Threads`,
the Heartbeat Map (2026-08-10), HB ACK, ECHOCAT JS8 messaging.

## What it is

JS8Call's decentralized HF mail: a station holds messages for others
(`MSG TO:K1ABC hello`), answers `QUERY MSGS` with undelivered mail IDs,
serves `QUERY MSG <ID>`, and relays via `CALL1>CALL2>text` paths. POTACAT's
edge over JS8Call's version: the inbox lives in MAIN (survives window
close), pushes to the phone when mail lands, and the Heartbeat Map already
draws the topology the relay network runs on.

## Architecture

### 1. The store (`lib/js8-mailbox.js`, pure + tested)
Rows: `{ id, from, to, path, text, checksum, receivedAt, deliveredAt,
state: 'held'|'delivered'|'expired' }`, persisted to
`<userData>/js8-mailbox.json`. Dedupe by checksum (a message heard twice is
one message). TTL default 7 days; cap ~200 held messages, oldest expire.

### 2. Accept + serve (main, on decoded directed traffic)
- `MSG TO:<CALL> <text>` addressed to us (or to a group we serve): store,
  ACK per protocol.
- `QUERY MSGS` from CALL: reply with the oldest undelivered ID held for
  CALL (`YOURCALL MSG ID <id>` form).
- `QUERY MSG <id>`: transmit the body (multi-frame, checksummed — the
  varicode layer already carries CHECKSUM_CMDS for exactly this).
- Mark delivered on the requester's ACK, not on transmit.

### 3. Announce (the self-organizing part)
On decoding a heartbeat from a station we hold mail for:
`<CALL> HEARTBEAT SNR <snr> MSG <id>` — the HB ACK path extended (cmd 29
already parsed). Mail goes looking for its recipient. Rate-limited with the
existing HB ACK dupe window.

### 4. Relay policy
Whose mail will we hold/relay? Default: **group-scoped** — accept `MSG TO:`
for members of groups the operator has joined (composes with the shipped
group support). Open relay invites abuse; whitelist-only means no network.
Per-call overrides in settings.

### 5. Duty-cycle governor (the trust-deciding part)
Hard limits, all visible in the ⚙ gear: max TX seconds per hour (default
~120 s), max hops (3), TTL, max queue depth, and a kill switch. Every
automatic transmission logs `[JS8 MAIL]` lines. The governor is a pure
module (`lib/js8-mail-governor.js`) with tests — its refusals are the
feature.

## Part 97 posture (the load-bearing constraint)

Serving `QUERY MSGS` / `QUERY MSG` is response-to-interrogation — the same
class as HB ACK, shipped with the attended watchdog. **Unattended announce +
relay is automatic control, and 14.078 is not a §97.221 automatic-control
subband.** Therefore:
- v1 ships ATTENDED-ONLY: everything rides the existing 30-min operator
  watchdog, exactly like HB ACK. Session-only enables.
- An "unattended mailbox" mode (watchdog off) is a separate, later decision
  gated on real regulatory review — a user-facing setting with the §97.221
  subband question stated plainly, never a default.

## ECHOCAT (where it gets good)

- Push notification when mail lands (`js8-mail` S2C + the activity feed).
- Read/reply from the phone; Guest Pass sees group mail only, DMs stay
  owner-private (the shipped privacy split).
- Heartbeat Map gains a "holding mail for" badge per station.

## Sequencing (each step ships value alone)

1. **Inbox receive-only**: store `MSG TO:` addressed to us, phone push. No
   new TX at all. (~2 days)
2. **Serve queries** (attended): QUERY MSGS / QUERY MSG + governor. (~3 days)
3. **Announce on heartbeat** (attended). (~1 day)
4. **Relay paths + map badges.** (~3 days)
5. Unattended mode — only after the regulatory question is settled.
