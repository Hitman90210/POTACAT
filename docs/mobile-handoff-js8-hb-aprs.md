# Mobile handoff — JS8 round 3: heartbeat automation, APRS gateway, TX progress

**From:** POTACAT desktop
**To:** ECHOCAT mobile
**Date:** 2026-08-10
**Desktop state:** shipped on master (post-1.10.3). All S2C fields below
already flow; the two new C2S messages are registered + demuxed
(protocol-demux-parity-test green). Field-validated on air (K9ROB HB ACK).

## 1. New `js8-state` fields (S2C, already flowing)

| Field | Type | Meaning / render |
|---|---|---|
| `hbAck` | bool | ⚙ "Reply to heartbeats" — session-only automatic TX. Render as a toggle beside Auto-HB. |
| `swrAutoTune` | bool | ⚙ "Auto-tune on high SWR" (persisted). Toggle in your SWR/rig options. C2S for it is desktop-IPC only today — ask if you want a wire setter. |
| `aprsGate` | bool | ⚙ APRS-IS gateway opt-in (persisted). |
| `aprsGateUp` | bool | gateway socket is connected AND login-verified. Show "connected / connecting…" beside the toggle. |
| `hbNextAt` | epoch ms | when the Auto scheduler transmits next; `0` = scheduler off. **Count down locally** (desktop shows "Auto · 12m") — no per-second wire traffic. Resets when a manual HB fires (manual send restamps the interval). |
| `txTotal` | int | frames in the current message. With `txQueue` (frames not yet started) you get progress: during TX show **"TX (total−queue)/total"**; idle+queued show "N tx queued". Desktop: "TX 1/3 → 2/3 → 3/3". |
| `txOffset` / `rxOffset` | Hz | audio-passband offsets (operator-set; quiet-spot picking moves txOffset before CQ/HB). Display-only for now — `js8-set-offset` is desktop IPC; ask if you want it on the wire. |

`heartbeatMin` (existing) is now user-editable in the desktop ⚙ gear; keep
sending it via `js8-heartbeat {intervalMin}` as before.

## 2. New C2S messages (registered, demuxed, handled)

- **`js8-set-hback { enabled }`** — toggle HB auto-reply. **Guest-refused**
  (`_js8Refuse` — it arms automatic TX). Session-only on the host: it is OFF
  at every desktop launch and self-disarms after 30 min without operator
  activity; your toggle may snap back off via `js8-state` — render whatever
  the state says, never latch locally.
- **`js8-set-aprs-gate { enabled }`** — toggle the RF→APRS-IS gateway.
  **Guest-refused** (publishes under the owner's callsign). Persisted.
  Internet-only — it never transmits, so no attended watchdog.

No reqId on either — the `js8-state` echo is the confirmation (same pattern
as `js8-heartbeat`).

## 3. Behavior changes worth mirroring in copy/UX

- **HB ACK semantics** (host-enforced, you get them free): never ACKs into a
  tripped SWR match, never mid-QSO/TX, never our own call, one ACK per
  station per 30 min, 30-min attended watchdog. When the watchdog disarms it
  the host pushes `hbAck:false` — show it plainly ("turned off — no
  activity for 30 min").
- **Desktop window lifecycle:** the desktop JS8 window now auto-starts JS8 on
  open and stops it on close — **except when a phone is connected**, so your
  running session is never killed by the desktop window closing. Nothing for
  you to do; just know a desktop-side stop can no longer yank JS8 out from
  under you.
- **Quiet-spot TX:** CQ/HB auto-move to the clearest ~50 Hz slot; a manual
  offset pins it. You'll see `txOffset` move on its own — that's intended.
- **Heard-rail grids** now persist per call (a gridless message no longer
  wipes a learned grid) and are scraped from CQs as well as HBs — your heard
  list gets more grids with zero changes.

## 4. Heartbeat Map (desktop-only today; data available on ask)

Desktop shipped an RX-only reachability map: stations heard (`js8Heard` —
you already receive this via `js8-heard`), plus **`js8HeardBy`** — stations
whose SNR replies prove they hear US. `heardBy` is NOT on the wire yet; if
you want to build the mobile map, ask and we'll add a `js8-heard-by` S2C
broadcast (same shape as `js8-heard`: `[{call, snr, utc, grid}]`).

## 5. Deferred / specced (do not build yet)

- Outbound SMS/email packet builder: `docs/js8-aprs-messaging-spec.md`.
- Store-and-forward mailbox: `docs/js8-store-forward-spec.md`. Both will get
  their own handoffs when the desktop side lands.

---

## ADDENDUM (2026-08-10, same day)

### HB ACK no longer self-disarms — signal it prominently

Casey: "Reply should happen until I turn it off, not for 30 mins." The 30-min
idle watchdog is REMOVED from HB ACK — it now replies until the operator
turns it off (it is response-to-interrogation, like JS8Call's own autoreply,
not beaconing). Still session-only: OFF at every desktop launch.

**Mobile must signal the auto-reply state visibly** — while `js8-state.hbAck`
is true the station transmits on its own whenever a heartbeat is decoded, and
an operator glancing at their phone needs to know that. Render a persistent
"AUTO REPLY" badge/chip on the JS8 tab bar (info color, not red) whenever
`hbAck` is true, not just a buried toggle. Ignore the earlier "may snap back
off via the watchdog" note — it can now only change when someone toggles it.

### New in `js8-state` (this addendum's batch)

| Field | Meaning |
|---|---|
| `groups` | array of joined @NETS (⚙ gear, persisted `settings.js8Groups`). Pin these in the conversation rail like @ALLCALL/@HB; messages to them count as "for you". C2S `js8-set-groups` is desktop-IPC only — ask for a wire setter if you want editing on mobile. |
| `mailUnread` | count of unread JS8 MAIL held by the station (receive-only store-and-forward v1: "MSG <text>" addressed to the owner is stored, survives restarts). Count only — mail CONTENT has no wire channel yet; it lands in the normal thread push too, so guests still see nothing beyond group rules. Badge it like thread unread. |

### Outbound SMS/email (desktop shipped; mobile = ask first)

Desktop ⚙ gear now sends one-way SMS/email via `@APRSIS` (main builds the
padded packet; `js8-send-sms` is desktop IPC). If you want it on mobile,
ask for the wire message — same shape: `{kind:'sms'|'email', to, text}` with
the send-result channel for refusals.
