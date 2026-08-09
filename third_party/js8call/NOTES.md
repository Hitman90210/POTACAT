# JS8Call vendored sources

Upstream: https://github.com/JS8Call-improved/JS8Call-improved
Commit: see `UPSTREAM_COMMIT` (cloned 2026-08-09, post-v3.0.3 master).
License: GPLv3 (see `LICENSE` here). This is the component that makes the
POTACAT combined work GPLv3 — see the repository `NOTICE`.

## What is vendored

- `JS8_Mode/` — the JS8 modem: `JS8.cpp` (five `DecodeMode<>` submode decoders
  A/B/C/E/I = Normal/Fast/Turbo("JS8 40")/Slow/Ultra("JS8 60"), plus
  `JS8::encode()` frame→tones), `JS8Submode.*` (per-submode constants),
  `FrequencyTracker.*`, `ldpc_feedback.h`, `soft_combiner.h`,
  `whitening_processor.h`.
- `JS8_Include/commons.h` — `dec_data` (12 kHz int16 ring buffer + decode
  window parameters). POTACAT defines the actual globals in
  `lib/js8_native/js8_addon.cc`; upstream defines them in its main window.
- `vendor/Eigen`, `vendor/CRCpp` — exactly as shipped by upstream.
- `kissfft/` — NOT from JS8Call: Mark Borgerding's kissfft (BSD-3-Clause),
  backing the `fftw3.h` shim in `lib/js8_native/fftw_shim/`. Upstream links
  real FFTW3 (GPL); kissfft avoids carrying a second copy of FFTW when
  `lib/ft8_native` already embeds kissfft anyway.
- `boost/` — header-only subset (crc, math/ccmath, multi_index + transitive
  closure), Boost Software License 1.0.

## Deliberately NOT vendored

- `Varicode.cpp` / `JSC*` (the message layer): ported to JavaScript at
  `lib/js8-varicode.js` + `lib/js8-jsc-table.js` instead —
  `QRegularExpression`'s PCRE named groups and QString's UTF-16 semantics map
  onto JavaScript's native regex/strings far more faithfully than onto
  `std::regex`/`std::string`, and the port is testable under plain node. That
  port is a derivative work of the GPL originals and is marked as such.
- `Modulator.cpp` — a Qt audio device. Tone→audio synthesis is ~30 lines of
  continuous-phase math, reimplemented in `js8_addon.cc`.
- `Decoder.cpp` / `Detector.cpp` — Qt threading/audio plumbing. The addon has
  its own driver (running inside a Node worker thread), and the decode
  scheduling is a direct port of upstream `isDecodeReady()`
  (`JS8_UI/mainwindow.cpp`).

## Local modifications to upstream files

Kept to the absolute minimum so a future upstream refresh is a re-diff, not a
re-port:

1. `JS8_Mode/JS8.cpp` — the Qt `Worker`/`Decoder` section (which requires moc)
   is wrapped in `#ifndef JS8_NO_QT`. Nothing inside the decode path changed.
2. `JS8_Main/Varicode.h` — reduced to only the protocol enums
   (`SubmodeType`/`TransmissionType`/`FrameType`), which is all
   `JS8Submode.cpp` includes it for. The full message codec is the JS port.

Everything else compiles UNMODIFIED against the stub Qt headers in
`lib/js8_native/qt_stub/` (no-op logging, `qMin`/`qint32`-style shims) and the
`fftw3.h`-over-kissfft shim. If a future upstream bump adds Qt types inside
the decode path itself, extend the stubs — do not patch the source.
