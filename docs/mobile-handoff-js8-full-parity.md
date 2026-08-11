# Mobile handoff — JS8 full parity: mailbox, SMS/email, heartbeat map

**From:** POTACAT desktop
**To:** ECHOCAT mobile
**Date:** 2026-08-10
**Supersedes/collects:** `mobile-handoff-js8-hb-aprs.md` (+ addendum), the
RESPONSE-RESPONSE parity doc, and `mobile-handoff-js8-mailbox.md`. This is
the one build list. Every message below EXISTS on the wire now — registered
in `lib/echocat-protocol.js`, demuxed, parity test green. The "ask first"
items from earlier docs have all been granted and wired.

## Build 1 — Mail inbox (owner-only)

See `mobile-handoff-js8-mailbox.md` §1–2 for the full contract. Summary:
- S2C `js8-mail {id, from, text, utc}` — push on store → notification.
- S2C `js8-mail-list {messages}` — hydration at connect; rows carry `readAt`.
- C2S `js8-mail-read {id}` (`"all"` accepted). Guest-refused.
- Badge from `js8-state.mailUnread`. Guests: nothing, ever (DM-class).
- Keep mail a distinct surface from conversation threads.

## Build 2 — SMS/email sender (NEW wire, this doc)

- **C2S `js8-send-sms { kind: 'sms'|'email', to, text, reqId? }`** —
  guest-refused. The host builds the APRS packet (9-char padded addressee,
  `{NN` sequence, gateway callsigns from settings) and transmits over
  `@APRSIS`; you send only the raw form fields.
- Result rides the existing **`js8-send-result`** (with your `reqId`).
  Success means ON THE AIR, not delivered — mirror the desktop copy:
  "On the air — needs a listening APRS gateway to deliver."
- Form: kind picker, to (phone or email, validate per kind), message
  (**67-char cap**), and a live airtime estimate:
  `frames ≈ ceil((30 + to.length + text.length) / 10)`, ~15 s per frame.
  Show it BEFORE send — a 50-char body is over a minute of key-down.
- TX progress then shows via `js8-state` `txTotal`/`txQueue` as usual.

## Build 3 — Heartbeat Map (NEW wire, this doc)

- **S2C `js8-heard-by { list }`** — stations whose SNR replies prove they
  hear US; same row shape as `js8-heard` (`{call, snr, utc, grid}`), sent on
  change + hydrated at connect. Public RF — not guest-filtered.
- With `js8-heard` you can now draw the desktop's map: **green** = I hear
  them, **blue** = they hear me, **amber** = both; home at `settings.grid`.
  Stations without a grid stay list-only (never guess a position); show the
  honest "N of M mapped" count. Grids arrive via heartbeats/CQs, so
  coverage builds over minutes — say "Listening…" early, not "empty".
- Desktop also badges stations it holds mail for; that list is in its map
  channel only. If you want it, ask — one field (`mailFor: [calls]`).

## Also new in `js8-state` (declared in the registry)

| Field | Meaning |
|---|---|
| `mailHold` | ⚙ hold mail for other stations (default true). Display-only. |
| `mailUnattended` | ⚙ serve mail while away (default false). If shown, keep it display-only on mobile — the §97.221 automatic-control judgment belongs on the desktop where the warning copy lives. |

## Host behavior you get free (no mobile work)

- Mail serving is quadruple-gated (attended-or-opt-in, TX guards, duty-cycle
  governor ~120 s/hour + 4 serves/station/hour, full logging).
- HB ACKs append `MSG ID <id>` when the ACKed station has mail here.
- The SMS sequence counter, packet padding, and gateway configurability are
  all host-side; a gateway service change never touches mobile.

## Suggested order

1. Mail inbox + push notification (highest user value; wire is complete).
2. SMS/email form (small; reuses your send-result plumbing).
3. Map (biggest lift; `js8-heard-by` + `js8-heard` are both flowing).

## Build 4 — Idle program picker (added 2026-08-10)

- **C2S `set-idle-rx { mode: 'sstv'|'wspr'|'psk31'|'js8' }`** — which program
  the station launches after the idle threshold (Auto-RX). Guest-refused
  (it changes what the station does unattended). Persisted; the current
  value now rides the settings blob as **`idleRxMode`** — render a 4-way
  picker, current value from settings, no local latching.
- `js8` is NEW on desktop too: idle now opens the JS8 window (auto-start +
  day/night QSY), so the heartbeat net, HB ACKs (if on), mail intake, and
  the APRS gate all run while the operator is away; activity-state shows it
  like the other idle programs, and mail arrival still pushes `js8-mail`.
