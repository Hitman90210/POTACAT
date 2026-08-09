// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// fftw3.h shim: the exact FFTW API surface the vendored JS8 modem uses,
// backed by kissfft (BSD-3-Clause, third_party/js8call/kissfft).
//
// Why not real FFTW: FFTW is GPL, large, and needs per-platform binary
// builds — the reason js8lib exists upstream. The modem creates seven fixed
// plans per submode and executes them once per decode pass, so planner
// sophistication buys nothing here; kissfft computes the same DFT.
//
// Contract notes, each verified against the call sites in JS8.cpp:
//   - fftwf_complex is float[2], layout-identical to kiss_fft_cpx.
//   - FFTW_BACKWARD is the UNNORMALIZED inverse; kissfft's inverse is also
//     unnormalized, so scaling matches.
//   - r2c output is n/2+1 bins, same as kiss_fftr. kiss_fftr requires even
//     n; every JS8 FFT size is even (asserted at plan creation).
//   - FFTW_ESTIMATE_PATIENT appears in upstream call sites but is defined
//     by their build environment, not by fftw3.h — defined here.

#ifndef POTACAT_FFTW3_SHIM_H
#define POTACAT_FFTW3_SHIM_H

#ifdef __cplusplus
extern "C" {
#endif

typedef float fftwf_complex[2];
typedef struct potacat_fftwf_plan_s *fftwf_plan;

#define FFTW_FORWARD (-1)
#define FFTW_BACKWARD (+1)

#define FFTW_ESTIMATE (1U << 6)
#define FFTW_MEASURE (0U)
#define FFTW_PATIENT (1U << 5)
#define FFTW_ESTIMATE_PATIENT (1U << 7)

fftwf_plan fftwf_plan_dft_1d(int n, fftwf_complex *in, fftwf_complex *out,
                             int sign, unsigned flags);
fftwf_plan fftwf_plan_dft_r2c_1d(int n, float *in, fftwf_complex *out,
                                 unsigned flags);
void fftwf_execute(fftwf_plan plan);
void fftwf_destroy_plan(fftwf_plan plan);

#ifdef __cplusplus
}
#endif

#endif // POTACAT_FFTW3_SHIM_H
