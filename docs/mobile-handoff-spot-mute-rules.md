# Mobile handoff — per-band region mutes (Ron N7BBQ)

**Desktop built + signed off 2026-08-03.** Report: daily ~2100Z JA activators
on 40m that he can never work keep stopping his scan; a global Asia filter is
too blunt because he wants the same stations on 15m. (Thread correction that
matters for UI copy: JA is continent **AS** — the existing Oceania toggle
would not have touched them.)

## The model

A mute rule hides ONE region on ONE band:

```json
{ "continent": "AS", "band": "40m" }
```

- `continent`: cty.dat 2-letter code — `AF AN AS EU NA OC SA`.
- `band`: lowercase lib/bands.js token (`40m`, `15m`, `2m`, …).
- Rules are **desktop-owned** (`settings.spotMuteRules`), sanitized on every
  write (unknown continents dropped, bands lowercased, deduped, capped at 50).
- Strictly additive to the existing global region filter — the blanket case
  is already covered by the region toggles you ship today.

## Wire contract — exact shapes (learned from the rig-control incident: these
are spelled precisely; trust this section, and if a shipped sender ever
disagrees, flag it before matching either)

**Receive (S2C)** — rules arrive inside the existing `echo-filters` push,
merged in at send time:

```json
{ "type": "echo-filters", "data": { "...": "your own roaming filter prefs",
    "muteRules": [ { "continent": "AS", "band": "40m" } ] } }
```

- `data.muteRules` **absent** → older desktop, treat as none/unknown.
- Empty array → explicitly no rules.
- Your `set-echo-filters` sends are unchanged and **cannot clobber the
  rules** — the desktop merges them into the payload at send only; they are
  not part of the client filter blob you own.

**Edit (C2S, optional — see UI section)** — full-list replace, fields at the
**top level** (this message does NOT nest under `data`):

```json
{ "type": "set-spot-mute-rules", "rules": [ { "continent": "AS", "band": "40m" } ] }
```

The desktop sanitizes and echoes the **accepted** set inside the next
`echo-filters` push — settle your UI on that echo, don't latch the tap (same
contract as the rig toggles and the split button).

## The predicate (mirror exactly)

A spot is hidden when any rule matches:

```
upper(spot.continent) === rule.continent AND lower(spot.band) === rule.band
```

- Spots with **no resolved continent never match** — a rule must not hide
  what it can't classify.
- Every spot the desktop pushes already carries `continent` (cty.dat at
  ingestion, all sources); no lookup needed on your side.
- Apply it wherever spots are filtered — list, map, and any scan/next-spot
  logic, so muted spots don't stop a scan (that was Ron's actual pain).

## UI asks

1. **Apply + display are required; the editor is optional.** Active rules
   must be visible wherever they apply — an invisible filter reads as
   missing spots and becomes a bug report. Desktop shows a list + count
   badge under Spots → Region; web shows a read-only "Muted: Asia on 40m"
   note. Your equivalent is your call, but absent-from-UI is not an option
   when rules are active.
2. **If you build the editor**: desktop's add flow is one tap from the
   offending spot (right-click → "Hide Asia on 40m", label derived from the
   spot's resolved continent + band, offered only when both resolved and no
   such rule exists). A long-press action on a spot row is the natural
   mirror. Removal is an × on the rules list. Send the full list via
   `set-spot-mute-rules`.
3. Treat rules as **cross-device state**, not device-local — one list, the
   desktop is the store, every surface converges on the `echo-filters` echo.

## Deliberately deferred (don't build ahead)

Entity-level rules (JA specifically vs all-Asia — the rule shape will extend
with an optional field, additive), and time-windowed rules. If you find
yourselves needing either, ask first so the shapes stay aligned.

## Validation

Desktop predicate + sanitizer are unit-tested (test/spot-mute-rules-test.js,
9 cases). Ron N7BBQ is the reporter and natural end-to-end tester once both
sides ship — his acceptance case: rule "Asia on 40m" active, 40m JA spots
gone from list/map/scan on every surface, the same callsigns still visible
on 15m.

## Unrelated but adjacent desktop fix worth knowing

While validating this, we found the desktop's right-click spot menu had been
throwing (and silently dead) since the watchlist-add buttons shipped in
early July — fixed the same day. If you had any "desktop right-click does
nothing" reports queued, they're resolved; no mobile impact.
