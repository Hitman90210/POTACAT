# Mobile Handoff — open into the running activity (idle-results feed)

**Audience:** POTACAT mobile (iOS / Android) team
**Scope:** Wire contract + UX for landing the app INSIDE whatever the
desktop is doing — idle WSPR with its accumulated spots, a JS8 inbox, a
mid-flight SSTV decode — instead of a stale tab and empty panes.
**ALL desktop work is BUILT (2026-08-09).**
**Origin:** Casey (K3SBP): "When my computer is idle, I may have WSPR
running and when I sit at my computer, I see all of the WSPR spots...
when I get on the mobile app, it doesn't show any of those spots. ...
have the mobile app open to the idle application that we're running...
if I open my phone and see that I am in the middle of a SSTV decode, I
may wish to wait until it's complete."

---

## The shape of the feature

Three problems, one design:

1. **The phone didn't know what the desktop was doing.** New:
   `activity-state`, one cached S2C snapshot — the ROUTER. Hydrated first
   in the connect burst so you can navigate before content arrives.
2. **Idle results weren't on the wire.** New: `wspr-session` (the
   accumulated session, not the last 2-minute batch); SSTV status/progress/
   last-image now cached and replayed. JS8 already hydrated (previous
   handoff). PSK31 already replayed its text tail.
3. **"Should I wait?" wasn't answerable.** `activity-state.busy` carries
   `tx`, `decoding`, and — mid-SSTV-decode — `progress` and `etaMs`.

Capability gate: server hello `capabilities` now contains **`"activity"`**.
Absent = older desktop = keep your current landing behavior.

## Wire contract

Registry: `lib/echocat-protocol.js`; prose: `docs/echocat-protocol.md`
§ "Activity ("now") feed". Working summary:

### `activity-state` (S2C, cached, hydrated FIRST)

```json
{ "type": "activity-state",
  "activity": "wspr",
  "auto": true,
  "since": 1754790000000,
  "detail": { "dialMHz": 14.0956, "hopping": false, "sessionCount": 47 },
  "busy": { "tx": false, "decoding": false } }
```

- `activity`: `idle | jtcat | js8 | psk31 | wspr | sstv | freedv`. ONE
  primary activity by design (multi-slice may add `secondary` later —
  ignore unknown fields).
- `auto`: true when Auto-RX idled into this (the "the desktop did this by
  itself" badge); false when the operator started it.
- `since`: ms epoch the CURRENT activity began — render "WSPR for 1h 12m".
- `detail` varies by activity:
  - `wspr`: `{dialMHz, hopping, sessionCount}`
  - `js8`: `{submode, unread}` — unread lets the router badge before the
    threads payload lands
  - `jtcat`: `{mode}` (`FT8`/`FT4`/`FT2`)
  - `sstv` decoding: `{mode: "Martin 1", decoding: true}`
  - `sstv` armed (auto-RX waiting for a signal): `{armed: true, freqKhz}`
  - `psk31`, `freedv`, `idle`: `{}`
- `busy`: `{tx, decoding, progress?, etaMs?}`. During an SSTV decode,
  `progress` is 0–1 and `etaMs` is derived from observed line pace (honest
  for every SSTV mode; absent below ~3% progress). **This is the "wait for
  it" surface** — see UX below.
- Debounced ~150 ms on the desktop; pushed on every edge (engine
  start/stop/mode change, SSTV vis/line/image, PTT, Auto-RX transitions,
  FreeDV lifecycle). Between pushes the cached copy is authoritative.

### `wspr-session` (S2C, cached)

```json
{ "type": "wspr-session", "startedAt": 1754786400000, "count": 47,
  "active": true,
  "spots": [ { "call": "W1AW", "grid": "FN31", "snr": -21,
               "freqMHz": 14.097045, "dt": 0.2, "drift": 0, "dBm": 37,
               "timeUtc": "1432", "distanceMi": 210, "bearing": 64,
               "entity": "United States", "continent": "NA" } ] }
```

- The SESSION's accumulated spots — what the desktop popout shows after an
  hour of idle WSPR. Cap 500 (oldest dropped); `count` is the session total
  (can exceed 500). Field note: frequency is **`freqMHz`** (MHz, float) —
  there is no `freqHz`; `dBm` is the sender's reported power; `dt`/`drift`
  come from wsprd. Enrichment (`entity`/`continent`/`distanceMi`/`bearing`)
  is host-side and may be absent when the grid or cty lookup failed.
- The session starts lazily on the FIRST decoded batch: a WSPR session
  that has heard nothing yet sends no `wspr-session` at all —
  `activity-state.detail.sessionCount: 0` is your "running, nothing heard"
  signal.
- `active: false` = the session ended (mode changed away / JTCAT stopped)
  but the results are still worth showing — render as "last session".
  A new session replaces the payload wholesale on the next decode batch.
- **`jtcat-wspr-spots` is unchanged** (latest batch, replace-the-list).
  Keep consuming it for the live view if you already do; `wspr-session` is
  the accumulation. Replace-not-merge on every `wspr-session` payload.

### SSTV (existing messages, now cached + replayed at connect)

- `sstv-tx-status` — last state (`auto-rx` with `freqKhz` = armed and
  parked; `tx`; `rx`).
- `sstv-rx-progress` — replayed ONLY while a decode is actually running
  (`mode: "decoding"`, `line`, `totalLines`, `progress`). A finished
  decode's 100% is never replayed.
- `sstv-rx-image` — the LAST completed picture (base64 PNG in `image`,
  plus `mode`/`width`/`height`/`timestamp`). One image, so hydration cost
  is bounded; the full gallery remains on request via `sstv-get-gallery`.

### Hydration order (all three auth paths — paired legacy, paired hello, Guest Pass)

```
auth-ok → spots → status
        → activity-state → wspr-session → sstv-tx-status
        → sstv-rx-progress (if decoding) → sstv-rx-image (last)
        → js8-state → js8-threads → js8-heard
        → (…the rest of the legacy burst)
```

`activity-state` lands immediately after `status` on every path — router
before content, guaranteed. (Corrected 2026-08-09: an earlier draft showed
the JS8 trio first and, on the hello path, the router used to arrive after
the whole JTCAT block; the code now matches this order.)

Guests receive all of the above, with one shaping rule: **JS8 thread data
is group-nets-only for a pass session** (No DMs — see the JS8 handoff's
guest section), `js8-threads.unread` and `activity-state.detail.unread`
are recomputed over the rows the guest can see, and a changed-thread delta
the guest may not see drops both fields. Guest CONTROL refusals are
unchanged.

## UX expectations

1. **Open into the activity.** On connect (and on foreground-resume
   reconnect), read the hydrated `activity-state` and land on the matching
   surface: `wspr` → the WSPR view showing `wspr-session`; `js8` → the JS8
   inbox; `sstv` → the SSTV view; `jtcat` → the FT8 tab; `idle` → your
   current default. Respect an explicit in-app navigation the user made
   THIS session — route on connect, don't yank tabs afterward. `since` and
   `auto` belong in the header: "Auto-RX · WSPR · 1h 12m · 47 spots".
2. **The wait-for-it moment.** When `busy.decoding` is true, the SSTV view
   shows the live progress bar and ETA from `activity-state.busy` (and the
   finer `sstv-rx-progress` ticks as they stream). If the user reaches for
   a control that would take the radio (PTT, tune, mode start), interpose:
   "SSTV decode in progress — done in about 40 s" with Wait / Take the
   radio anyway. Never silently block; the operator outranks the decode.
3. **Idle results read as results.** The WSPR view renders the session
   list (sorted newest first; `distanceMi`/`bearing`/`entity` are
   host-enriched — render as-is, no lookups). `active:false` sessions get
   a "last session" header, not a live one. The SSTV view shows the last
   image immediately with its timestamp — "decoded 22 minutes ago".
4. **Badging.** `activity-state` is cheap and always current: the app's
   home/tab chrome can show a persistent one-line "now" strip (activity +
   since + the session counter) wherever you already surface connection
   state.

## Rules that are not optional

- **`activity-state` routes; the per-mode messages are the content.** Do
  not derive "what is running" from `jtcat-status`/`sstv-tx-status`
  anymore — you already found the `mode:'JS8'` trap that game leads to
  (docs/desktop-asks/js8-mobile-gaps.md, mobile-side note). One router.
- **Replace, never merge** `wspr-session.spots` payloads.
- **Trust `busy`, don't infer it.** A stale SSTV decode on the desktop
  expires out of the feed after 60 s of silence — you never need a
  client-side staleness timer.
- **No emojis in UI copy; "mobile device", not "phone"** (project style).

## Testing against a real desktop

1. Desktop: Settings → enable Auto-RX with idle mode WSPR, walk away until
   it triggers (or start JTCAT in WSPR mode manually). Let it run 10+ min.
2. Connect the app: hydration must land `activity-state {activity:'wspr',
   auto:true}` + `wspr-session` with the accumulated spots — with NO live
   event needed. Kill and reopen the app: same result.
3. Switch the desktop to FT8: `wspr-session {active:false}` arrives; the
   view flips to "last session".
4. SSTV: start Auto-SSTV, feed it a signal (the desktop's own test corpus
   works: `scripts/test-sstv.js` can play one), connect mid-decode:
   `activity-state.busy` carries progress/eta, `sstv-rx-progress` ticks,
   and the completed picture lands as `sstv-rx-image`.
5. Repeat 2 on a Guest Pass session — identical hydration, controls still
   refused.

Desktop cross-references: `main.js` § "Activity state — the \"now\" feed"
(computeActivityState/pushActivityState/wsprSessionAppend),
`lib/remote-server.js` (`_sendActivityHydration` — the shared helper all
three auth paths call), `lib/echocat-protocol.js` (registry),
`test/idle-activity-test.js` (the invariants above, pinned).
