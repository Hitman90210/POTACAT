# POTACAT — Native JS8 (no JS8Call app, no virtual cables)

Status: **BUILT 2026-08-09 — all phases.** Commits `e38c5f6` (relicense),
`6602953` (vendor), `9dc8e9a` (modem addon + varicode port + engine),
`9069da0` (main.js integration + bridge deletion). All five submodes round
trip through the real modem (`test/js8-native-test.js`); the full station
loop — text → frames → period-aligned TX → audio → decode → interpreted
conversation — closes in `test/js8-engine-test.js`. The bridge and its
virtual-cable route are deleted. **Remaining: on-air validation** (the
release gate — nothing here has heard a real signal yet) and the follow-ups
listed at the end. This document is now the record of what was decided and
why; the phase list below matches what was built.

Decision: **POTACAT relicenses Apache-2.0 → GPLv3 so JS8Call's codec can be
compiled in.** Casey, 2026-08-08, after rejecting the virtual-cable path three
times: *"ECHOCAT remains its own product, so I have no concerns there."*

## One correction to the premise, because the plan depends on it

`JS8Call-improved/js8lib` is **not** a JS8 library. Its tree is
`boost/ fftw/ submodules/ BUILD.sh` — prebuilt build dependencies for their CI,
described in its own README as *"only for JS8Call-improved developers."* It also
carries **no license at all** (GitHub API reports `license: null`), which grants
fewer rights than GPL, not more.

The codec lives in the **JS8Call application sources** (`js8call/js8call`,
GPLv3, the JS8Call-improved lineage, currently v3.0.3). That is what this plan
vendors. Everything below assumes those sources, not `js8lib`.

Alternatives checked and rejected, so they are not re-checked later:
`rtmrtmrtmrtm/fate` (MIT, real, but 11 commits over four days in Feb 2022 —
Normal speed only, no compound callsigns, against JS8Call's current seven
speeds); `js8-rs` (Apache/MIT, 4 commits, message packing only, no FEC or
demod); `js8py` (GPL, parses another decoder's text output). And there is **no
standalone `js8` binary to invoke as a subprocess** — 3.0 ported the Fortran to
C++ and eliminated the separate decoder process, so the mere-aggregation escape
hatch that works for `wsprd` and Mercury is unavailable for JS8.

## What this kills

Every part of the current JS8 path that the operator has to get right:

- the virtual audio cable (VB-CABLE / VoiceMeeter strip↔bus routing)
- JS8Call.exe itself, its `.ini` patching, and its launch supervision
- DAX, the DAX control panel, and the "give JS8Call its own slice" machinery
- the one-API-client-at-a-time limit
- the `js8call` **preemptive** radio-owner — nothing external keys any more, so
  POTACAT stops having to yield the transmitter to an app it cannot control

What is left is the shape that already works here every day: POTACAT decodes off
the `dax_rx` stream it already has and transmits on `dax_tx`, exactly like JTCAT.

---

## Phase 0 — Relicense (blocking; must complete before any GPL source lands)

Order matters. If GPL sources enter the tree while the repo still says
Apache-2.0, we have published a license violation.

- `LICENSE` → GPLv3 text. `package.json` `"license": "GPL-3.0-or-later"`.
  `NOTICE` and the README License section rewritten.
- **Per-file headers stay `SPDX-License-Identifier: Apache-2.0` on everything
  Casey wrote.** The *combined binary* is GPLv3 because it links a GPL
  component; his individual files remain his to relicense elsewhere. This is the
  structure that preserves commercial optionality on his own code.
- **A CLA (or DCO) must land before further outside contributions**, or that
  optionality is lost one PR at a time. Four existing external contributors came
  in under MIT, which permitted the earlier relicense.
- `TRADEMARKS.md` unchanged — the names are protected by trademark, not the code
  license, and forks must still rename.
- **Dependency audit:** every current dependency must be GPLv3-compatible.
  Electron (MIT), Chromium (BSD), Apache-2.0 deps (one-way compatible) are fine.
  Flag anything CDDL/EPL/proprietary. `resources/cloudflared` is Apache-2.0.
- Document the ECHOCAT boundary in-repo: mobile is a separate program that only
  *receives* decodes over the network protocol and contains no decoder, so the
  GPL component does not reach the sold app.
- `third_party/js8call/` gets the upstream `LICENSE` + a `NOTICE` entry, same
  convention as Mercury.

## Phase 1 — Extraction spike (**do this first, outside the repo**)

Relicensing is irreversible for the combined work; this spike is what tells us
the decoder can be detached from the GUI at all. Run it in a scratch directory,
not in `potacat-dev`.

1. Clone JS8Call 3.0.3. Locate the codec surface: LDPC(174,87), the three
   7-symbol Costas arrays at symbol positions 0/36/72 (sequence 4,2,5,6,1,3,0),
   the 8-FSK demodulator, the varicode/message packing, and the modulator.
2. Build a standalone C++ harness that decodes a WAV file and prints results.
3. **Acceptance gate:** decode a real off-air recording captured from Casey's
   own radio and match JS8Call's decodes on the identical audio. POTACAT can
   dump its `dax_rx` stream to a WAV, so the test vector is a real band, not a
   synthetic file.

**This phase's real output is a risk answer, not code:** how entangled is the
decoder with Qt (`QObject`/`QThread`/`QAudio`)? If it needs shims, budget them
here. Everything after this is ordinary work; this is the part that could
surprise us.

## Phase 2 — `lib/js8_native/` (N-API addon)

Same pattern as `lib/ft8_native/`, which is the proof this works here.

- `binding.gyp` — **`#` comments only**; `/* */` silently breaks the gyp build.
- Build Linux artifacts on **ubuntu-22.04** (glibc 2.35), never 24.04.
- Surface: `decode(samples, {speeds, freqRange})`, `encode(text, {speed})`,
  `setStation({call, grid})`. Decode tries the enabled speeds — JS8Call decodes
  several concurrently and we need parity.
- `npm run build-js8`, added to `scripts/build-natives.js`.

## Phase 3 — `lib/js8-engine.js` as an `Ft8Engine` contract sibling

**This is the elegance lever: do not build a parallel stack.**
`lib/psk-engine.js` is already documented as a "drop-in Ft8Engine contract
sibling hosted by jtcat-manager". JS8 becomes the second one, and inherits, for
free: slice hosting, audio routing, the TX dispatch choke point, PTT,
`handleRemotePtt`, the SWR guard, the radio-owner arbiter, the waterfall, and
per-band RX gain.

Two traps already documented and both load-bearing:

- **`Ft8Engine.setMode` COERCES unknown modes to FT8**, so an FT-family ↔ JS8
  switch must **rebuild the slice**, exactly as the PSK31 path does in the
  `jtcat-set-mode` handler in `main.js`.
- **Never write `settings.jtcatLastMode`** with a JS8 mode, for the same reason.

## Phase 4 — Keep the application layer entirely

The parts built for the bridge are exactly what a native implementation needs;
only the transport changes. Keep, unmodified where possible:

- `lib/js8call-threads.js` — conversation grouping, heartbeat folding, unread
  that survives the popout closing. It consumes *frames* and does not care
  whether they arrived over a TCP socket or from our own decoder. Its test suite
  (`test/js8call-threads-test.js`) stays green throughout.
- `renderer/js8call-popout.*` — the message view, minus its setup screen.

## Phase 5 — Delete the fragile layer

**Same release as native JS8** (Casey, 2026-08-08) — so this is gated on on-air
validation, not merely sequenced after it. Nothing ships until native JS8 is
good enough to be the only option.

Remove: `lib/js8call-client.js`, `lib/js8call-config.js`,
`lib/js8call-process.js`, `lib/js8call-slice.js`, `lib/js8call-audio.js`,
`lib/js8call-audio-bridge.js`, `renderer/js8-audio-bridge.*`,
`preload-js8-audio-bridge.js`, `js8KeyForTx*` and the TX silence guard, the DAX
prerequisite checks, and `js8call` as a radio-owner.

Settings retired with a one-time migration that clears them and says so once:
`js8AudioBridge`, `js8AudioRxDevice`, `js8AudioTxDevice`, plus the DAX/slice
keys. Their tests go with them; `test/js8call-main-wiring-test.js` shrinks to
whatever still exists.

## Phase 6 — What "elegant" means concretely

- **No setup screen at all.** JS8 appears in the JTCAT mode picker next to
  FT8/FT4/PSK31. Pick a speed, press start. That is the whole configuration.
- Speed selector present from v1 but showing **Normal** only; the other six
  appear as each one's corpus and sensitivity comparison land.
- Heartbeat and auto-reply are POTACAT settings, **off by default**, with the
  Part-97 attended semantics described under "Heartbeat" — a station that
  transmits unprompted is automatic operation and must be a deliberate choice.
- The inbox already survives the window closing, because thread state lives in
  main. Unchanged.
- ADIF logs `MODE=JS8` via `adifModeSubmode`, alongside the hunted-park and
  EVENT stamping FT8 already does.
- **ECHOCAT / phone: JS8 threads ride the WS protocol like PSK31 does.** This
  was Casey's original goal for JS8Call and it stops being a special case —
  the phone gets an inbox because the desktop has one.
- PSKReporter spotting of JS8 decodes reuses the existing IPFIX path.
- **Multi-slice finally means something here:** owning the decoder makes JS8 on
  one slice and FT8 on another genuinely possible. Four slices receiving four
  modes is fine; more than one *transmitting* is not, on any radio with one
  transmitter.

## Phase 7 — Tests and regression invariants

- `test/js8-native-test.js` — encode→decode round trip across all speeds,
  including compound/slash callsigns (the FT4 nonstd silent-TX failure is the
  precedent for why this is not optional).
- A **recorded-audio corpus** with a decode-count floor, modelled on the SSTV
  PSNR matrix and `scripts/test-ap-decode.js`, so a refactor cannot silently
  deafen the decoder.
- The sensitivity comparison against JS8Call on identical audio becomes a
  checked-in harness, not a one-off — it is the only evidence that replacing a
  maintained decoder did not cost the operator dB.

---

## Risks and unknowns, honestly

1. **Qt entanglement of the decoder** — the single largest unknown, and the
   whole reason Phase 1 runs before Phase 0's irreversible step.
2. **CPU cost.** Seven speeds × multiple slices, on a Raspberry Pi in headless
   mode. May force a per-speed enable list rather than "decode everything".
3. **Sensitivity parity is unproven until measured.** An architecture win that
   costs 3 dB is a worse radio.
4. **On-air validation is required** and this project has a standing habit of
   shipping things that still need it.
5. **GPLv3 is irreversible for the combined work** once JS8Call code is in.

## Decisions (Casey, 2026-08-08)

- **Heartbeat is required in v1.** Not a follow-on. See "Heartbeat" below.
- **The bridge is deleted in the same release that lands native JS8.** No dual
  path, no fallback setting, no "which JS8 am I running" confusion. The
  consequence is deliberate and should not be softened later: **on-air
  validation becomes a release blocker**, because there is nothing to fall back
  to. Given this project's standing pile of "needs on-air validation" items,
  that is the right pressure.
- **Speeds: ship Normal in v1**, with the parameter table built for all seven
  from day one. See "Speed strategy" below.

## Speed strategy

The seven speeds (Slow, Normal, Fast, Turbo, Ultra, JS8 40, JS8 60) are **the
same 79-symbol frame at different baud rates and tone spacings** — not different
protocols. So the decoder is parameterized, not duplicated, and the marginal
*code* cost of speed N+1 is a table row. Exact per-speed parameters come out of
the source in Phase 1; do not hard-code values derived from documentation.

What is *not* free:

1. **CPU.** Each enabled speed is another full search over the same audio, per
   period, per slice. Headless mode runs on a Raspberry Pi. This is the real
   constraint on "just enable everything", and Phase 1 must measure it.
2. **Test surface.** Every speed we claim needs its own round-trip test, its own
   recorded corpus, and its own sensitivity comparison against JS8Call. That is
   the actual work, and it is per-speed.

Hence: Normal in v1, because the heartbeat network runs there and it is the bulk
of on-air traffic; the rest enabled individually as each one's corpus and
comparison land. Shipping seven speeds at once means claiming seven things we
have validated on air on the same day, which is exactly the pattern that keeps
producing unvalidated features here.

Build the table for all seven immediately even though only one is exposed —
retrofitting a speed dimension into a single-speed decoder is the expensive
version of this.

## Heartbeat (required, v1)

POTACAT owns the heartbeat network now, which means owning its transmit
behaviour. What is already done and what is not:

**Already built:** `lib/js8call-threads.js` `isHeartbeatText()` folds the HB net
into a per-thread count instead of a wall of noise, and unread survives the
popout closing. The inbox side needs nothing.

**To build:**

- HB scheduler — periodic `@HB HB <GRID>`, operator-set interval, off by
  default until switched on.
- HB ACK: answering heartbeats we hear is how the mesh maps itself, and is the
  point of participating at all.
- **Part-97 framing, borrowed wholesale from ULTRACAT.** A station that
  transmits unprompted on a timer is automatic operation. It gets the same
  attended-operator watchdog (`JTCAT_FULL_AUTO_CQ_WATCHDOG_MS`, 30 min), the
  same deliberate opt-in, and it stands down for any other radio owner rather
  than contending for the transmitter.
- The old `js8MayTransmitUnprompted()` signal disappears with the bridge — it
  existed to warn that *JS8Call* might key behind our back. Now the answer is
  knowable exactly, because POTACAT is the only thing keying.

## Sequencing

**Phase 1 spike (scratch dir) → decision point → Phase 0 relicense → Phases
2–4 → on-air validation → Phase 5 deletion → Phase 6 polish.**

The decision point after the spike is real: if the decoder will not detach from
Qt at acceptable cost, the answer is not to relicense anyway — it is to
reconsider, with the cable path still working in the tree.
