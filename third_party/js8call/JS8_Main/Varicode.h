// POTACAT local modification (see NOTES.md): reduced from upstream
// JS8_Main/Varicode.h to ONLY the protocol enums, which is all the vendored
// modem (JS8Submode.cpp) uses. The full Varicode message codec is ported to
// JavaScript at lib/js8-varicode.js; the Qt-heavy original is not vendored.
//
// Upstream copyright (C) 2018-2026 Jordan Sherer <kn4crd@gmail.com>
// License: GPLv3 (see ../LICENSE)

#ifndef VARICODE_H
#define VARICODE_H

class Varicode {
  public:
    // submode types
    enum SubmodeType {
        JS8CallNormal = 0,
        JS8CallFast = 1,
        JS8CallTurbo = 2,
        JS8CallSlow = 4,
        JS8CallUltra = 8
    };

    // frame type transmitted via itype and decoded by the ft8 decoder
    enum TransmissionType {
        JS8Call = 0,      // [000] <- any other frame of the message
        JS8CallFirst = 1, // [001] <- the first frame of a message
        JS8CallLast = 2,  // [010] <- the last frame of a message
        JS8CallData = 4,  // [100] <- flagged frame (no frame type header)
    };

    /*
    000 = heartbeat
    001 = compound
    010 = compound directed
    011 = directed
    1XX = data, with the X lsb bits dropped
    */
    enum FrameType {
        FrameUnknown = 255,        // [11111111] <- only used as a sentinel
        FrameHeartbeat = 0,        // [000]
        FrameCompound = 1,         // [001]
        FrameCompoundDirected = 2, // [010]
        FrameDirected = 3,         // [011]
        FrameData = 4,             // [10X] first 2 msb bits, lsb dropped
        FrameDataCompressed = 6,   // [11X] first 2 msb bits, lsb dropped
    };
};

#endif // VARICODE_H
