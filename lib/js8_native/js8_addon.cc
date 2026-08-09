// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// N-API driver for the vendored JS8 modem (third_party/js8call, GPLv3 —
// the reason the POTACAT combined work is GPLv3; see NOTICE).
//
// Architecture: this whole file is ONE translation unit with JS8.cpp
// included into it. That is not laziness — the five DecodeMode<> submode
// decoders live in an anonymous namespace inside JS8.cpp, exactly so that
// only the Worker in the same TU can reach them. We replace that Worker
// (it needs Qt and moc; JS8_NO_QT guards it out) with this driver, and the
// anonymous namespace requires us to live in its TU to do so.
//
// Threading: every export here is SYNCHRONOUS and expects to be called from
// lib/js8-worker.js, a Node worker thread — the same containment jtcat uses
// for the FT8 decoder. A decode pass can take hundreds of milliseconds; on
// the Electron main thread that would be a UI stall, on a worker it is
// nothing. Do not require() this addon from the main process.
//
// The decode scheduling (per-submode ring windows) is a faithful port of
// isDecodeReady() from upstream JS8_UI/mainwindow.cpp — the one piece of
// the application we reimplement rather than vendor, because upstream's
// lives tangled in the UI class. Buffer geometry, cycle computation and the
// dead-air reset rules are kept bit-for-bit so the decoders see the same
// windows they would under JS8Call.

#define JS8_NO_QT 1

#include "JS8_Mode/JS8.cpp" // NOLINT — deliberate TU inclusion, see above

#include "JS8_Main/Varicode.h"
#include "JS8_Mode/JS8Submode.h"

#include <node_api.h>

#include <cmath>
#include <cstring>
#include <numbers>
#include <string>
#include <vector>

// The globals the vendored code declares extern (upstream defines these in
// its main window; we are the "main window" now).
struct dec_data dec_data;
struct specData specData;
std::mutex fftw_mutex;

namespace {

// ── decode scheduling state ─────────────────────────────────────────────────

struct SubmodeSlot {
    int submode;      // Varicode::SubmodeType value (0,1,2,4,8)
    int shift;        // bit position in dec_data.params.nsubmodes
    int *kpos;        // window start, inside dec_data.params
    int *ksz;         // window size, inside dec_data.params
    // isDecodeReady() state, formerly function-local statics in upstream.
    int currentDecodeStart = -1;
    int nextDecodeStart = -1;
};

SubmodeSlot g_slots[5] = {
    {Varicode::JS8CallUltra, 4, &dec_data.params.kposI, &dec_data.params.kszI},
    {Varicode::JS8CallSlow, 3, &dec_data.params.kposE, &dec_data.params.kszE},
    {Varicode::JS8CallTurbo, 2, &dec_data.params.kposC, &dec_data.params.kszC},
    {Varicode::JS8CallFast, 1, &dec_data.params.kposB, &dec_data.params.kszB},
    {Varicode::JS8CallNormal, 0, &dec_data.params.kposA, &dec_data.params.kszA},
};

int g_prevK = 9999999; // upstream's k0 init value

// The five decoders. Construction builds FFT plans (heavy), so they are
// built once, lazily, and reused — mirroring upstream Worker::Impl, whose
// instances also live for the program and accumulate soft-combiner state
// across passes.
struct Decoders {
    // DecodeMode and the Mode tag types live in a global-scope anonymous
    // namespace inside JS8.cpp — reachable unqualified from this TU only,
    // which is the entire reason this file includes JS8.cpp.
    DecodeMode<ModeA> a;
    DecodeMode<ModeB> b;
    DecodeMode<ModeC> c;
    DecodeMode<ModeE> e;
    DecodeMode<ModeI> i;
};
Decoders *g_decoders = nullptr;

Decoders &decoders() {
    if (!g_decoders) g_decoders = new Decoders();
    return *g_decoders;
}

// Port of upstream isDecodeReady() (JS8_UI/mainwindow.cpp). Comments and
// structure kept close to the original so a future diff is reviewable.
bool isDecodeReady(SubmodeSlot &s, int const k, int const k0, int *pStart,
                   int *pSz) {
    int const cycleFrames = JS8::Submode::samplesPerPeriod(s.submode);
    int const framesNeeded = JS8::Submode::samplesNeeded(s.submode);
    int const currentCycle =
        JS8::Submode::computeCycleForDecode(s.submode, k);
    int const delta = std::abs(k - k0);

    // are we in the space between the end of the last decode and the start
    // of the next decode?
    bool const deadAir =
        (k < s.currentDecodeStart &&
         k < std::max(0, s.currentDecodeStart - cycleFrames + framesNeeded));

    // on buffer loop or init, prepare proper next decode start
    if (deadAir || (k < k0) || (delta > cycleFrames) ||
        (s.currentDecodeStart == -1) || (s.nextDecodeStart == -1)) {
        s.currentDecodeStart = currentCycle * cycleFrames;
        s.nextDecodeStart = s.currentDecodeStart + cycleFrames;
    }

    bool const ready = s.currentDecodeStart + framesNeeded <= k;

    if (ready) {
        *pStart = s.currentDecodeStart;
        *pSz = std::max(framesNeeded, k - s.currentDecodeStart);
        s.currentDecodeStart = s.nextDecodeStart;
        s.nextDecodeStart = s.currentDecodeStart + cycleFrames;
    }

    return ready;
}

// ── napi plumbing ───────────────────────────────────────────────────────────

napi_value throwError(napi_env env, const char *msg) {
    napi_throw_error(env, nullptr, msg);
    return nullptr;
}

double numArg(napi_env env, napi_value obj, const char *name, double dflt) {
    napi_value v;
    if (napi_get_named_property(env, obj, name, &v) != napi_ok) return dflt;
    napi_valuetype t;
    napi_typeof(env, v, &t);
    if (t != napi_number) return dflt;
    double d;
    napi_get_value_double(env, v, &d);
    return d;
}

// ── exports ─────────────────────────────────────────────────────────────────

// appendAudio(Float32Array samples12k) -> k
//
// Samples are mono float32 at exactly 12000 Hz, [-1, 1]; conversion to the
// modem's int16 happens here. Ring semantics match upstream Detector: write
// linearly, wrap to 0 at JS8_RX_SAMPLE_SIZE (the scheduler detects the wrap
// via k < k0 and resets its windows).
napi_value AppendAudio(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "appendAudio needs a Float32Array");

    napi_typedarray_type type;
    size_t length;
    void *data;
    if (napi_get_typedarray_info(env, argv[0], &type, &length, &data, nullptr,
                                 nullptr) != napi_ok ||
        type != napi_float32_array)
        return throwError(env, "appendAudio needs a Float32Array");

    auto const *f = static_cast<float const *>(data);
    int k = dec_data.params.kin;
    constexpr int RING = JS8_RX_SAMPLE_SIZE;
    for (size_t n = 0; n < length; ++n) {
        float v = f[n];
        if (v > 1.0f) v = 1.0f;
        if (v < -1.0f) v = -1.0f;
        dec_data.d2[k] = static_cast<std::int16_t>(v * 32767.0f);
        if (++k >= RING) k = 0;
    }
    dec_data.params.kin = k;

    napi_value out;
    napi_create_int32(env, k, &out);
    return out;
}

// reset() — clear the ring and all window state (band change, RX restart).
napi_value Reset(napi_env env, napi_callback_info) {
    std::memset(dec_data.d2, 0, sizeof dec_data.d2);
    dec_data.params.kin = 0;
    g_prevK = 9999999;
    for (auto &s : g_slots) s.currentDecodeStart = s.nextDecodeStart = -1;
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

// decode({submodes, nfa, nfb, nfqso, utc}) -> { decodes: [...], k }
//
// submodes: bitmask of Varicode::SubmodeType bit POSITIONS as upstream uses
// them in nsubmodes (bit0=Normal .. bit4=Ultra). Runs every submode whose
// window is ready; a call when nothing is ready is cheap and returns [].
napi_value Decode(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    napi_value opts = argv[0];
    if (argc < 1) napi_create_object(env, &opts);

    int const wantMask = static_cast<int>(numArg(env, opts, "submodes", 1));
    dec_data.params.nfa = static_cast<int>(numArg(env, opts, "nfa", 500));
    dec_data.params.nfb = static_cast<int>(numArg(env, opts, "nfb", 2700));
    dec_data.params.nfqso = static_cast<int>(numArg(env, opts, "nfqso", 1500));
    dec_data.params.nutc = static_cast<int>(numArg(env, opts, "utc", 0));
    dec_data.params.syncStats = false;
    dec_data.params.newdat = true;

    int const k = dec_data.params.kin;
    int const k0 = g_prevK;
    g_prevK = k;

    // Which submodes have a full period of audio ready?
    int runMask = 0;
    if (k != k0) {
        for (auto &s : g_slots) {
            if (!(wantMask & (1 << s.shift))) continue;
            int start = -1, sz = -1;
            if (isDecodeReady(s, k, k0, &start, &sz)) {
                *s.kpos = start;
                *s.ksz = sz;
                runMask |= (1 << s.shift);
            }
        }
    }

    struct Row {
        int utc, snr, type;
        float dt, freq, quality;
        int mode;
        std::string text;
    };
    std::vector<Row> rows;

    if (runMask) {
        dec_data.params.nsubmodes = runMask;
        auto emitter = [&rows](JS8::Event::Variant const &ev) {
            if (auto const *d = std::get_if<JS8::Event::Decoded>(&ev)) {
                rows.push_back({d->utc, d->snr, d->type, d->xdt, d->frequency,
                                d->quality, d->mode, d->data});
            }
        };
        // Same order as upstream Worker::Impl: faster modes first.
        auto &dm = decoders();
        if (runMask & (1 << 4)) dm.i(dec_data, dec_data.params.kposI, dec_data.params.kszI, emitter);
        if (runMask & (1 << 3)) dm.e(dec_data, dec_data.params.kposE, dec_data.params.kszE, emitter);
        if (runMask & (1 << 2)) dm.c(dec_data, dec_data.params.kposC, dec_data.params.kszC, emitter);
        if (runMask & (1 << 1)) dm.b(dec_data, dec_data.params.kposB, dec_data.params.kszB, emitter);
        if (runMask & (1 << 0)) dm.a(dec_data, dec_data.params.kposA, dec_data.params.kszA, emitter);
    }

    napi_value result, decodesArr;
    napi_create_object(env, &result);
    napi_create_array_with_length(env, rows.size(), &decodesArr);
    for (size_t i = 0; i < rows.size(); ++i) {
        auto const &r = rows[i];
        napi_value row, v;
        napi_create_object(env, &row);
        napi_create_int32(env, r.utc, &v); napi_set_named_property(env, row, "utc", v);
        napi_create_int32(env, r.snr, &v); napi_set_named_property(env, row, "snr", v);
        napi_create_double(env, r.dt, &v); napi_set_named_property(env, row, "dt", v);
        napi_create_double(env, r.freq, &v); napi_set_named_property(env, row, "freq", v);
        napi_create_int32(env, r.type, &v); napi_set_named_property(env, row, "type", v);
        napi_create_double(env, r.quality, &v); napi_set_named_property(env, row, "quality", v);
        napi_create_int32(env, r.mode, &v); napi_set_named_property(env, row, "mode", v);
        napi_create_string_utf8(env, r.text.c_str(), r.text.size(), &v);
        napi_set_named_property(env, row, "text", v);
        napi_set_element(env, decodesArr, i, row);
    }
    napi_set_named_property(env, result, "decodes", decodesArr);
    napi_value kv;
    napi_create_int32(env, k, &kv);
    napi_set_named_property(env, result, "k", kv);
    napi_value ranv;
    napi_create_int32(env, runMask, &ranv);
    napi_set_named_property(env, result, "ran", ranv);
    return result;
}

// encode({frame, type, submode, freq, sampleRate}) ->
//   { tones: Int32Array(79), audio: Float32Array }
//
// frame: EXACTLY 12 characters of the JS8 alphabet (the Varicode JS layer
// produces these). type: the 3-bit transmission type for this frame.
// Synthesis is continuous-phase 8-FSK — upstream Modulator's math
// (phase-accumulated qSin) without its Qt audio device — with 10 ms raised
// cosine key envelopes, at the requested sampleRate so no caller resamples.
napi_value Encode(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "encode needs an options object");
    napi_value opts = argv[0];

    napi_value frameV;
    if (napi_get_named_property(env, opts, "frame", &frameV) != napi_ok)
        return throwError(env, "encode needs frame");
    char frame[16] = {0};
    size_t frameLen = 0;
    napi_get_value_string_utf8(env, frameV, frame, sizeof frame, &frameLen);
    if (frameLen != 12)
        return throwError(env, "encode frame must be exactly 12 characters");

    int const type = static_cast<int>(numArg(env, opts, "type", 0));
    int const submode = static_cast<int>(numArg(env, opts, "submode", 0));
    double const freq = numArg(env, opts, "freq", 1500.0);
    double const rate = numArg(env, opts, "sampleRate", 12000.0);

    int tones[JS8_NUM_SYMBOLS];
    try {
        JS8::encode(type, JS8::Costas::array(JS8::Submode::costas(submode)),
                    frame, tones);
    } catch (std::exception const &e) {
        return throwError(env, e.what());
    }

    // Symbol timing at the output rate. samplesForOneSymbol is at 12 kHz;
    // scale, keeping the exact total duration.
    double const sps12k = JS8::Submode::samplesForOneSymbol(submode);
    double const spsOut = sps12k * rate / 12000.0;
    double const spacing = JS8::Submode::toneSpacing(submode);
    int const total =
        static_cast<int>(std::ceil(spsOut * JS8_NUM_SYMBOLS));

    napi_value audioBuf, audioArr;
    void *audioData;
    napi_create_arraybuffer(env, total * sizeof(float), &audioData, &audioBuf);
    auto *out = static_cast<float *>(audioData);

    double const tau = 2.0 * std::numbers::pi;
    double const rampN = std::min(rate * 0.010, spsOut); // 10 ms
    double phi = 0.0;
    for (int n = 0; n < total; ++n) {
        int sym = static_cast<int>(n / spsOut);
        if (sym >= JS8_NUM_SYMBOLS) sym = JS8_NUM_SYMBOLS - 1;
        double const f = freq + tones[sym] * spacing;
        phi += tau * f / rate;
        if (phi > tau) phi -= tau;
        double amp = 1.0;
        if (n < rampN)
            amp = 0.5 * (1.0 - std::cos(std::numbers::pi * n / rampN));
        else if (n >= total - rampN)
            amp = 0.5 * (1.0 - std::cos(std::numbers::pi * (total - 1 - n) / rampN));
        out[n] = static_cast<float>(amp * std::sin(phi));
    }

    napi_create_typedarray(env, napi_float32_array, total, audioBuf, 0,
                           &audioArr);

    napi_value tonesBuf, tonesArr;
    void *tonesData;
    napi_create_arraybuffer(env, sizeof tones, &tonesData, &tonesBuf);
    std::memcpy(tonesData, tones, sizeof tones);
    napi_create_typedarray(env, napi_int32_array, JS8_NUM_SYMBOLS, tonesBuf, 0,
                           &tonesArr);

    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "audio", audioArr);
    napi_set_named_property(env, result, "tones", tonesArr);
    return result;
}

// submodeInfo(submode) -> constants the JS side needs for scheduling/UI.
napi_value SubmodeInfo(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    int submode = 0;
    if (argc >= 1) {
        double d = 0;
        napi_get_value_double(env, argv[0], &d);
        submode = static_cast<int>(d);
    }
    napi_value result, v;
    napi_create_object(env, &result);
    try {
        napi_create_string_utf8(env,
            JS8::Submode::name(submode).toStdString().c_str(),
            NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, result, "name", v);
        napi_create_uint32(env, JS8::Submode::period(submode), &v);
        napi_set_named_property(env, result, "period", v);
        napi_create_uint32(env, JS8::Submode::samplesPerPeriod(submode), &v);
        napi_set_named_property(env, result, "samplesPerPeriod", v);
        napi_create_uint32(env, JS8::Submode::samplesNeeded(submode), &v);
        napi_set_named_property(env, result, "samplesNeeded", v);
        napi_create_double(env, JS8::Submode::toneSpacing(submode), &v);
        napi_set_named_property(env, result, "toneSpacing", v);
        napi_create_uint32(env, JS8::Submode::bandwidth(submode), &v);
        napi_set_named_property(env, result, "bandwidth", v);
        napi_create_double(env, JS8::Submode::txDuration(submode), &v);
        napi_set_named_property(env, result, "txDuration", v);
        napi_create_uint32(env, JS8::Submode::startDelayMS(submode), &v);
        napi_set_named_property(env, result, "startDelayMS", v);
    } catch (std::exception const &e) {
        return throwError(env, e.what());
    }
    return result;
}

} // namespace

napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, "appendAudio", NAPI_AUTO_LENGTH, AppendAudio, nullptr, &fn);
    napi_set_named_property(env, exports, "appendAudio", fn);
    napi_create_function(env, "decode", NAPI_AUTO_LENGTH, Decode, nullptr, &fn);
    napi_set_named_property(env, exports, "decode", fn);
    napi_create_function(env, "encode", NAPI_AUTO_LENGTH, Encode, nullptr, &fn);
    napi_set_named_property(env, exports, "encode", fn);
    napi_create_function(env, "reset", NAPI_AUTO_LENGTH, Reset, nullptr, &fn);
    napi_set_named_property(env, exports, "reset", fn);
    napi_create_function(env, "submodeInfo", NAPI_AUTO_LENGTH, SubmodeInfo, nullptr, &fn);
    napi_set_named_property(env, exports, "submodeInfo", fn);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
