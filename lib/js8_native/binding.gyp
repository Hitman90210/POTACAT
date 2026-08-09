# SPDX-License-Identifier: Apache-2.0
# JS8 modem addon. gyp files take '#' comments ONLY — a C-style comment
# silently breaks the native build (see CLAUDE.md).
#
# The vendored decoder is C++20 (concepts, constexpr lambdas, std::numbers).
# JS8.cpp is compiled INTO js8_addon.cc (single TU — the decoders live in an
# anonymous namespace); it is not listed as a source.
#
# BOOST_INCLUDE can point at a full boost checkout during development; the
# repo carries the header subset at third_party/js8call/boost.
{
  "targets": [
    {
      "target_name": "js8_native",
      "sources": [
        "js8_addon.cc",
        "fftw_shim/fftw_shim.c",
        "../../third_party/js8call/JS8_Mode/JS8Submode.cpp",
        "../../third_party/js8call/JS8_Mode/FrequencyTracker.cpp",
        "../../third_party/js8call/kissfft/kiss_fft.c",
        "../../third_party/js8call/kissfft/kiss_fftr.c"
      ],
      "include_dirs": [
        "../../third_party/js8call",
        "../../third_party/js8call/boost",
        "qt_stub",
        "fftw_shim"
      ],
      "defines": ["JS8_NO_QT=1"],
      "cflags": ["-O2"],
      "cflags_cc": ["-std=c++20", "-O2", "-fexceptions"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions", "-std=gnu++17"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_CFLAGS": ["-O2"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 2,
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++20", "/bigobj", "/utf-8", "/Zc:__cplusplus"]
        }
      }
    }
  ]
}
