// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// kissfft-backed implementation of the fftw3.h shim. See fftw3.h for the
// contract notes; this file is deliberately boring.

#include "fftw3.h"

#include <assert.h>
#include <stdlib.h>

#include "kissfft/kiss_fft.h"
#include "kissfft/kiss_fftr.h"

struct potacat_fftwf_plan_s {
    int n;
    int is_r2c;
    float *rin;            /* r2c input */
    fftwf_complex *cin;    /* c2c input */
    fftwf_complex *out;
    kiss_fft_cfg cfg;      /* c2c */
    kiss_fftr_cfg rcfg;    /* r2c */
};

fftwf_plan fftwf_plan_dft_1d(int n, fftwf_complex *in, fftwf_complex *out,
                             int sign, unsigned flags) {
    (void)flags;
    struct potacat_fftwf_plan_s *p = calloc(1, sizeof(*p));
    if (!p) return NULL;
    p->n = n;
    p->is_r2c = 0;
    p->cin = in;
    p->out = out;
    /* FFTW_FORWARD (-1) is kissfft's forward (inverse=0). */
    p->cfg = kiss_fft_alloc(n, sign == FFTW_BACKWARD, NULL, NULL);
    if (!p->cfg) { free(p); return NULL; }
    return p;
}

fftwf_plan fftwf_plan_dft_r2c_1d(int n, float *in, fftwf_complex *out,
                                 unsigned flags) {
    (void)flags;
    assert(n % 2 == 0 && "kiss_fftr requires an even FFT size");
    struct potacat_fftwf_plan_s *p = calloc(1, sizeof(*p));
    if (!p) return NULL;
    p->n = n;
    p->is_r2c = 1;
    p->rin = in;
    p->out = out;
    p->rcfg = kiss_fftr_alloc(n, 0, NULL, NULL);
    if (!p->rcfg) { free(p); return NULL; }
    return p;
}

void fftwf_execute(fftwf_plan p) {
    if (!p) return;
    if (p->is_r2c)
        kiss_fftr(p->rcfg, p->rin, (kiss_fft_cpx *)p->out);
    else
        kiss_fft(p->cfg, (kiss_fft_cpx const *)p->cin, (kiss_fft_cpx *)p->out);
}

void fftwf_destroy_plan(fftwf_plan p) {
    if (!p) return;
    if (p->cfg) kiss_fft_free(p->cfg);
    if (p->rcfg) kiss_fft_free(p->rcfg);
    free(p);
}
