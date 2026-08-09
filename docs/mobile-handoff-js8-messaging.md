# Mobile Handoff — JS8 messaging (full send/receive from the phone)

**Audience:** POTACAT mobile (iOS / Android) team
**Scope:** Wire contract + UX for a complete JS8 messaging surface on the
phone — conversations, groups, unread, heard rail, compose/send, heartbeat,
start/stop.
**ALL desktop work is BUILT (2026-08-09).**
**Origin:** Casey (K3SBP): "The goal is for me to use ECHOCAT to be able to
send and receive JS8 from my phone connected to POTACAT. I need all buttons,
groups syncing, etc."

---

## Context: JS8 is native now

POTACAT no longer bridges to the JS8Call application — it decodes and
transmits JS8 itself (the JS8Call modem is compiled in; the engine runs
under JTCAT; the whole thing is GPLv3-relicensed to make that legal). What
that means for mobile:

- **There is no external program that can be misconfigured.** If the host
  says `running: true`, JS8 works. No DAX, no cables, no "is JS8Call open".
- **The conversation store lives in the desktop MAIN process**
  (`lib/js8call-threads.js`). Unread counts keep accumulating while every
  window — including your app — is closed. The phone renders that store; it
  never owns message state. An inbox that forgets is a log.
- **The phone is a peer of the desktop JS8 window, not a remote control for
  it.** Same store, same pushes, same one payload. If the two ever disagree
  about unread counts, that is a desktop bug — report it, don't paper over
  it client-side.

Capability gate: the server hello's `capabilities` array now contains
**`"js8"`**. Absent = older desktop = hide the whole surface.

## Wire contract

Everything rides the existing ECHOCAT WS session. Full field shapes are in
`lib/echocat-protocol.js` (the registry) and `docs/echocat-protocol.md`
(§ "JS8 (native HF messaging)"); this is the working summary.

### C2S (what you send)

```json
{ "type": "js8-start" }
{ "type": "js8-stop" }
{ "type": "js8-heartbeat", "enabled": true, "intervalMin": 15 }
{ "type": "js8-send", "text": "SNR?", "to": "KN4CRD", "reqId": "m1" }
{ "type": "js8-thread-open", "id": "KN4CRD" }
{ "type": "js8-thread-closed" }
```

- **`js8-send`: send `text` and `to` SEPARATELY.** The host composes the
  on-air form (`KN4CRD: SNR?` vs `@ALLCALL HELLO` — groups and individuals
  address differently). Never concatenate on the phone; a hand-addressed
  `text` would be transmitted verbatim on top of the host's addressing.
  `to` is a callsign or a `@GROUP`; omit it only when `text` is already a
  complete station call like `CQ CQ CQ`.
- `js8-heartbeat`: either field alone is valid. `intervalMin` (5–60)
  persists on the host; `enabled` is session-only there (see Heartbeat
  below).
- `js8-thread-open` marks the thread read ON THE HOST — that is the entire
  read-sync mechanism. Send `js8-thread-closed` when the user leaves the
  thread view (it releases the auto-read claim on new arrivals).
- `reqId` is yours; invent per tap, match on the result.

### S2C (what you receive)

```json
{ "type": "js8-state", "running": true, "tx": false, "txQueue": 0,
  "submode": "NORMAL", "heartbeat": false, "heartbeatMin": 15,
  "station": { "call": "K3SBP", "grid": "FN20" } }

{ "type": "js8-threads", "unread": 3, "changed": "KN4CRD",
  "list": [ { "id": "KN4CRD", "call": "KN4CRD", "isGroup": false,
              "unread": 2, "lastUtc": 1754700000000,
              "lastText": "HW CPY?", "lastDir": "in",
              "hbCount": 0, "count": 7 } ],
  "thread": { "id": "KN4CRD", "call": "KN4CRD", "isGroup": false,
              "hbCount": 0,
              "messages": [ { "dir": "in", "text": "HW CPY?",
                              "snr": -12, "offset": 1500,
                              "utc": 1754700000000 } ] } }

{ "type": "js8-thread", "thread": { /* same shape; null if unknown id */ } }
{ "type": "js8-heard", "list": [ { "call": "W1AW", "snr": -8,
                                    "utc": 1754700000000, "grid": "FN31" } ] }
{ "type": "js8-send-result", "ok": true, "text": "KN4CRD: SNR? ",
  "frames": 1, "reqId": "m1" }
```

- **Hydration at connect (in order): `js8-state` → `js8-threads` →
  `js8-heard`.** State first so you can gate controls before content lands.
  A phone that suspended for an hour reconnects to the inbox as it now
  stands — you never need to request a refresh, and there is no message for
  doing so.
- `js8-threads` arrives on EVERY inbox change (new message, read-state
  change from ANY surface, outgoing recorded). `list` is always complete
  (cap 60 threads) — replace, don't merge. When `changed` matches the
  thread the user is viewing, `thread` has its new content: update in place,
  no round trip.
- `js8-send-result` also carries **host-side start errors** ("Set your
  callsign…") and **Guest Pass refusals** — it is the one "why not" channel.
  Show `error` verbatim; the host writes operator-readable refusals.
- `utc` fields are ms epoch. `snr` is dB (can be null on outgoing). `offset`
  is the audio offset in Hz.

## UI expectations (parity with the desktop JS8 window)

The desktop window (`renderer/js8call-popout.*`) is the reference. The
pieces, in priority order:

1. **Conversation list** — groups pinned above individuals. `@ALLCALL` and
   `@HB` always exist even with zero traffic; any other `isGroup` row joins
   them, sorted alphabetically after the pinned two. Individuals sort by
   `lastUtc` descending. Unread badge per row (`unread`), total on the tab
   (`unread` from the payload root). Preview: `lastDir === 'out'` renders
   as "you: <lastText>"; a row with no `lastText` but `hbCount` renders
   "<hbCount> heartbeats".
2. **Thread view** — bubbles, `dir:'out'` right-aligned. Meta line: HH:MM
   from `utc`, plus `snr` dB and `offset` Hz on incoming. When `hbCount` is
   nonzero show a "N heartbeats hidden" pill — the folded net is stated,
   not hidden; that is the difference between "quiet band" and "we chose
   not to show you 40 heartbeats". Send `js8-thread-open` on entry (this is
   what clears the badge everywhere), `js8-thread-closed` on exit.
3. **Compose** — a destination picker (groups + open thread call + heard
   calls) and a text field. Preview line showing the composed form is nice
   but optional — `js8-send-result.text` is the authoritative echo; show it
   in the thread as the sent message (the host also records outgoing to the
   store, so the next `js8-threads` push has it — dedupe by rendering from
   the push, using the result only for failure UI).
   Quick chips, same set as desktop: `SNR?` `GRID?` `INFO?` `QSL` `73` —
   they FILL the field, never send.
4. **Heard rail** — `js8-heard` newest first with SNR and relative age.
   Tapping a heard station starts/opens a conversation with it (set the
   compose destination). There is no refresh request — the list updates as
   stations are decoded.
5. **Controls** — Start/Stop (from `js8-state.running`), heartbeat switch,
   TX indicator. `tx: true` = keyed this period; `txQueue > 0` = "N frames
   queued" (a long message transmits one frame per 15 s period — surface
   this, or a three-frame message looks stuck for 45 s). `submode` renders
   as a label (only NORMAL ships enabled today; render whatever arrives).

## Rules that are not optional

- **Heartbeat is attended-only (Part 97).** The host's enable is
  session-scoped and self-cancels after 30 minutes without operator
  activity — your switch WILL flip off on its own; render `js8-state`
  truthfully rather than latching the user's last tap. Sends and
  thread-opens from the phone count as operator activity on the host.
  Never re-enable automatically after reconnect; never persist the switch
  client-side.
- **Guest Pass is receive-only.** Guests may browse threads; `js8-start`,
  `js8-stop`, `js8-heartbeat` and `js8-send` come back as
  `js8-send-result {ok:false, error}`. Disable the controls when your
  session is a guest session, and show the error if a race lets one
  through. (The server refuses regardless — the UI gate is courtesy, the
  server is the law.)
- **Never compose addressing client-side** (worth repeating: the host owns
  `to` + `text` → on-air form).
- **No emojis in UI copy**, and say "mobile device", not "phone", in any
  user-facing text (project style).

## Edge cases the desktop already handles (so trust the pushes)

- Multi-frame messages arrive as ONE message in the store — the host
  reassembles frames and validates checksums. A failed checksum shows up in
  the message text handling on the host side; you render what you're given.
- Thread eviction (cap 60) never discards a thread with unread mail.
- The store folds heartbeat traffic into `hbCount` instead of message rows.
- Read-state changes from the DESKTOP also push `js8-threads` — your badges
  update when the operator reads mail at the radio, and vice versa.
- After `js8-stop` / engine stop, threads and heard remain (the inbox
  outlives the receiver); only `js8-state.running` changes. Keep rendering
  the inbox, disable compose.

## Testing against a real desktop

1. Desktop: start JS8 (More → JS8 → Start, or JTCAT mode picker → JS8).
2. `js8-state {running:true}` should arrive, then threads/heard as traffic
   decodes. 14.078 MHz USB is the busiest dial; the @HB net provides
   traffic within a few minutes on any open band.
3. Send `SNR?` to a heard station; watch `js8-send-result`, then the
   `js8-threads` push containing your outgoing message, then (with luck)
   the reply landing in the same thread.
4. Kill the app, let two messages arrive, reopen: hydration must show the
   unread badge without any request from your side.
5. Repeat 3 on a Guest Pass session: every control refused with a reason.

Desktop cross-references: `lib/js8-engine.js` (engine),
`lib/js8call-threads.js` (store — the shapes above are its `list()` /
`thread()` output verbatim), `lib/js8-rx-assembler.js` (multi-frame RX),
`main.js` § "JS8 from the phone" (the handlers), `lib/remote-server.js`
(demux + broadcasts + hydration), `docs/js8-native-plan.md` (why native).
