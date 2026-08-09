# Mobile Handoff — JS8 UI parity delta (HB semantics, period clock, ATU)

**Audience:** POTACAT mobile (iOS / Android) team
**Scope:** Three small parity items from the desktop JS8 window's first
real-use round. **No new wire messages** — one is a semantics change to a
message you already send, two are client-local UI. Flagged as a discrete
delta because your JS8 half is already built; these would otherwise hide
as silent edits in `mobile-handoff-js8-messaging.md` (which is updated
too).
**ALL desktop work is BUILT (2026-08-09, commit `8924780`).**

---

## 1. Heartbeat: enabling now TRANSMITS one immediately (semantics change)

`js8-heartbeat {enabled: true}` used to only arm the scheduler — the
immediate tick was silently swallowed by the interval gate if a heartbeat
had gone out recently. Now enabling resets that gate: **every enable
transmits one heartbeat now, then keeps the schedule.** (Casey: a button
named HB that only arms a timer is not a heartbeat. Also JS8Call's own HB
button semantics.)

What to change on your side:

- Render the switch as **"send now + repeat"**, not "arm a timer" — copy,
  affordance, and any confirmation should say a transmission happens on
  tap.
- Expect `js8-state` to tick right after enabling (`txQueue` 1 then `tx`
  true at the next period boundary).
- The tick's guards are unchanged: it will not preempt a queued message,
  key over another radio owner, or outlive the 30-minute attended
  watchdog. Nothing else about the Part-97 posture moved.

## 2. Period clock (client-local — build your own, no wire traffic)

The desktop bar now shows a countdown chip and a thin cycle strip: where
we are inside the current JS8 period. Parity spec:

- Periods align to wall-clock UTC: `into = Date.now() % periodMs`,
  countdown = `ceil((periodMs - into) / 1000)`.
- `periodMs` from `js8-state.submode`: NORMAL 15 s, FAST 10 s, TURBO 6 s,
  SLOW 30 s, ULTRA 4 s. Render whatever arrives; unknown → 15 s.
- Strip fills across the period; red while `js8-state.tx` is true, accent
  green otherwise. Hidden entirely when `running` is false — a period
  clock for a stopped engine is a lie.
- Tick locally (~250 ms). Do NOT derive it from server pushes; the whole
  point is that it runs between them. Device clock skew shows here the
  same way it does in FT8 — no correction needed beyond what your FT8
  surface already does (or doesn't).

## 3. ATU on the JS8 surface (client-local placement of an existing control)

The desktop JS8 bar gained the same momentary ATU button the JTCAT
surfaces carry. You already have the wire for this — `rig-control
{action: "atu-tune"}` — and the shared behavior note applies unchanged:
**momentary, never a toggle** (every press starts a match cycle), with a
brief "tuning" visual (~5 s). Parity ask: surface that existing control on
your JS8 screen too, so tuning up on the JS8 dial doesn't require leaving
the conversation view.

Guest Pass: `rig-control` is already refused for guests server-side; hide
the button in pass sessions like your other rig controls.

## 4. Band display + picker (NEW wire message — 2026-08-09, post-1.10.0)

First real use found the JS8 surface blind: no band shown, no way to
change it. Desktop now has a dial readout + band picker in the JS8 bar;
parity pieces for you:

- `js8-state` gained `dialHz` (number) and `band` (string, e.g. "20m") —
  band-granular pushes on QSY (the Hz-live stream stays on the radio
  status you already render). Show the band in your JS8 header.
- NEW C2S `js8-set-band {band, reqId?}` — tunes the rig to that band's
  JS8 calling dial (host owns the table: 1842/3578/5357/7078/10130/14078/
  18104/21078/24922/28078/50318 kHz). Refused for guests on
  `js8-send-result`. The host resets its RX reassembler on the QSY so a
  half-message from the old band can't corrupt the new one — nothing for
  you to do there.
- Band list for the picker: render the ten bands above; the host answers
  `{ok:false, error}` for anything it doesn't know.

---

Desktop cross-references: `renderer/js8call-popout.{html,js}` (the
reference implementation of all three), `main.js` `js8SetHeartbeat` (the
gate reset), `docs/mobile-handoff-js8-messaging.md` (updated in place —
the heartbeat bullet and this delta agree).
