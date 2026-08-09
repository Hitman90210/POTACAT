// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Minimal Qt stand-ins for compiling the vendored JS8 modem without Qt.
//
// The decode path in third_party/js8call uses Qt only for logging
// (qCDebug and friends), environment probes (qEnvironmentVariable*), and
// the integer/min/max convenience layer. The one genuinely Qt-dependent
// section — the Worker/Decoder thread wrapper — is guarded out with
// JS8_NO_QT (see third_party/js8call/NOTES.md). Everything here exists so
// the remaining upstream lines compile UNMODIFIED; none of it is a
// functional reimplementation of Qt.
//
// This header is reached through stub headers named <QtGlobal>, <QDebug>,
// <QLoggingCategory>, <QObject>, <QString>, <QSemaphore>, <QThread> in this
// directory, which the build puts on the include path ahead of any real Qt.

#ifndef POTACAT_QT_STUB_CORE_H
#define POTACAT_QT_STUB_CORE_H

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>

// ── integer typedefs ────────────────────────────────────────────────────────
using qint8 = std::int8_t;
using quint8 = std::uint8_t;
using qint16 = std::int16_t;
using quint16 = std::uint16_t;
using qint32 = std::int32_t;
using quint32 = std::uint32_t;
using qint64 = std::int64_t;
using quint64 = std::uint64_t;
using qreal = double;

// ── the convenience layer ───────────────────────────────────────────────────
template <typename T> constexpr T qMin(T a, T b) { return std::min(a, b); }
template <typename T> constexpr T qMax(T a, T b) { return std::max(a, b); }
template <typename T> constexpr T qBound(T lo, T v, T hi) { return std::clamp(v, lo, hi); }
template <typename T> constexpr T qAbs(T v) { return v < 0 ? -v : v; }
inline int qRound(double v) { return static_cast<int>(std::lround(v)); }
inline int qRound(float v) { return static_cast<int>(std::lround(v)); }

inline bool qEnvironmentVariableIsSet(const char *name) {
    return std::getenv(name) != nullptr;
}
inline int qEnvironmentVariableIntValue(const char *name, bool *ok = nullptr) {
    const char *v = std::getenv(name);
    if (!v || !*v) { if (ok) *ok = false; return 0; }
    char *end = nullptr;
    long r = std::strtol(v, &end, 10);
    bool good = end && *end == '\0';
    if (ok) *ok = good;
    return good ? static_cast<int>(r) : 0;
}

// ── QString, just enough for JS8Submode's names and error text ──────────────
class QString {
    std::string m_s;
  public:
    QString() = default;
    QString(const char *s) : m_s(s ? s : "") {}
    QString(std::string s) : m_s(std::move(s)) {}
    std::string const &toStdString() const { return m_s; }
    const char *toUtf8Data() const { return m_s.c_str(); }
    // .arg() only ever feeds diagnostics here; appending is faithful enough.
    template <typename T> QString arg(T v) const {
        return QString(m_s + " " + std::to_string(static_cast<long long>(v)));
    }
    QString arg(QString const &v) const { return QString(m_s + " " + v.m_s); }
    QString arg(const char *v) const { return QString(m_s + " " + (v ? v : "")); }
};
#define QStringLiteral(x) QString(x)

// ── QObject and the macro layer (declarations compile; nothing runs) ────────
class QObject {
  public:
    explicit QObject(QObject * = nullptr) {}
    virtual ~QObject() = default;
    static QString tr(const char *s) { return QString(s); }
};
#ifndef Q_OBJECT
#define Q_OBJECT
#endif
#ifndef Q_NAMESPACE
#define Q_NAMESPACE
#endif
#ifndef signals
#define signals public
#endif
#ifndef slots
#define slots
#endif
#ifndef emit
#define emit
#endif
#ifndef Q_EMIT
#define Q_EMIT
#endif

// ── threading decls used by the (guarded-out) Decoder class declaration ─────
class QSemaphore {
  public:
    explicit QSemaphore(int = 0) {}
    void acquire(int = 1) {}
    void release(int = 1) {}
};
class QThread : public QObject {
  public:
    enum Priority {
        IdlePriority, LowestPriority, LowPriority, NormalPriority,
        HighPriority, HighestPriority, TimeCriticalPriority, InheritPriority,
    };
    void start(Priority = InheritPriority) {}
    void quit() {}
    bool wait(unsigned long = 0) { return true; }
};

// ── logging: swallow everything at compile time ─────────────────────────────
struct QtStubNullDebug {
    template <typename T> QtStubNullDebug &operator<<(T const &) { return *this; }
    QtStubNullDebug &noquote() { return *this; }
    QtStubNullDebug &nospace() { return *this; }
    QtStubNullDebug &quote() { return *this; }
    QtStubNullDebug &space() { return *this; }
    QtStubNullDebug &maybeSpace() { return *this; }
    QtStubNullDebug &maybeQuote(char = '"') { return *this; }
};
enum QtMsgType { QtDebugMsg, QtInfoMsg, QtWarningMsg, QtCriticalMsg, QtFatalMsg };

// The declare/define macros expand to nothing (several headers declare the
// same category in one TU; producing definitions from the macro collides).
// But a category can also be CALLED directly —
// "if (decoder_js8().isDebugEnabled())" — so every category that is
// direct-called anywhere in the vendored decode path gets one inline
// function here. Currently that is exactly one; add others if an upstream
// refresh introduces them (the compile error is loud).
struct QtStubCategory {
    bool isDebugEnabled() const { return false; }
    bool isInfoEnabled() const { return false; }
    bool isWarningEnabled() const { return false; }
    bool isCriticalEnabled() const { return false; }
};
#define Q_DECLARE_LOGGING_CATEGORY(name)
#define Q_LOGGING_CATEGORY(...)
inline QtStubCategory const &decoder_js8() {
    static QtStubCategory c;
    return c;
}
#define qCDebug(...) QtStubNullDebug{}
#define qCInfo(...) QtStubNullDebug{}
#define qCWarning(...) QtStubNullDebug{}
#define qCCritical(...) QtStubNullDebug{}
#define qDebug(...) QtStubNullDebug{}
#define qWarning(...) QtStubNullDebug{}

#endif // POTACAT_QT_STUB_CORE_H
