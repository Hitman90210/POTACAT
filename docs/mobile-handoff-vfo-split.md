# Mobile handoff — VFO A/B + split readback (LZ3AW, TS-480SAT)

**Desktop side built 2026-08-03.** Report: with the radio on VFO B, every
POTACAT surface showed VFO A's frequency, nothing indicated the active VFO or
split, and there were no built-in VFO/split controls (he was using custom CAT
buttons).

## What changed on the desktop

- **The frequency readout now follows the active VFO.** Kenwood-family rigs
  are polled with `IF;` every cycle (RX-VFO digit + split flag), and the fast
  frequency poll switches between `FA;`/`FB;` accordingly. rigctld rigs poll
  `v` + `s` (hamlib's frequency was already active-VFO-correct — only the
  indicator was blind). CI-V and Yaesu readback are later phases; Yaesu keeps
  its working write-side controls with the old optimistic indicator.
- **Spot tunes target the active VFO** — tuning while on VFO B now writes FB
  instead of silently changing the inactive VFO A.
- **`status.vfo` is now trustworthy** (was optimistic-only: it tracked only
  POTACAT-initiated changes, so front-panel or custom-CAT VFO switches left
  it lying). **`status.split` is new** — boolean, absent from older desktops.
- Built-in controls now exist on desktop + web: VFO A / VFO B / Split,
  caps-gated (`capabilities.vfo`, `capabilities.split` — split is currently
  Kenwood-serial + rigctld, the readback-backed set).

## What mobile should do

1. **Render the active-VFO indicator and a SPLIT badge** from `status.vfo` /
   `status.split`. Treat absent `split` as unknown (older desktop), not off.
2. **Your existing `set-vfo` / `swap-vfo` senders are unchanged** and now
   route through the one dispatcher desktop-side; state settles from the
   status echo, so don't latch the tap — same contract as the rig toggles.
3. **Live split toggle**: send
   `{type:'rig-control', data:{action:'set-split', value:bool}}` — the
   canonical shape nests under `data` (the demux reads `msg.data.action`).
   **The first revision of this doc showed a top-level `action`, which the
   desktop silently dropped** — the mobile dev caught it by matching the
   shipped senders instead of the doc (correct call). The desktop now accepts
   both shapes and logs instead of silently dropping, but nest under `data`.
   Gate on `capabilities.split`.
4. **Registry fix that affects you:** `set-enable-atu` / `set-enable-split`
   were registered with field `on` but the shipped handlers read `value` — the
   registry now says `value`. If you implemented against the old registry,
   your sends were silently ignored; switch to `value`. (These toggle the
   spot-tune *settings*; they are not the live split control.)

## Validation

Desktop parse logic is unit-tested (test/rig-test.js "VFO/split readback"
section, 11 cases). On-air validation on a real TS-480 is pending — LZ3AW is
the reporter and the natural tester once a release carries this.

## Mobile shipped (2026-08-03, OTA dca34459)

Indicator + SPLIT badge on the VFO dial (top-left, `--` when unknown — they
also removed a `status?.vfo ?? 'A'` fallback that would have confidently shown
A the moment the readback said otherwise); live Split in Rig Controls,
caps-gated; absent `split` treated as unknown, not off. Their rename of the
old spot-tune "Split" button to **"Split on tune"** is endorsed desktop-side —
two adjacent buttons labeled "Split" doing different things is the same trap
as the multiFlex checkbox label (issue #67). Desktop's own web client had the
top-level-action bug they dodged; fixed same day.
