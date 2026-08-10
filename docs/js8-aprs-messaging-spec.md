# Spec — JS8 outbound SMS / email via APRS (the packet builder)

**Status:** SPEC — not built. Prereqs shipped: `lib/aprs-is.js` (packet
builders + gateway), the JS8 ⚙ gear (where the UI lands), `js8Transmit`.

## What it is

Operator-initiated, one-way text to a phone number or email address from an
off-grid JS8 station: POTACAT transmits `@APRSIS CMD <raw APRS packet>` over
JS8; any listening RF→IS gateway (including other POTACAT stations — shipped
2026-08-10) forwards it to APRS-IS, where the SMS/email gateway service
delivers it. Attended TX — no Part 97 automatic-control questions.

## Why a builder instead of a text box

The wire format fails SILENTLY on details users can't be expected to know:

- The APRS addressee field is **exactly 9 characters, space-padded**:
  `:SMSGTE   :` (6 + 3 spaces), `:EMAIL-2  :` (7 + 2). Wrong padding =
  packet dropped, no error, no bounce.
- **Email requires the `{NN` sequence number.** aprs-is.net documents
  EMAIL-2 as interactive (numbered messages + acks); blind senders risk
  being blocked. SMS via SMSGTE tolerates blind sends but numbering is safe.
- Gateway services churn — SMSGTE died in 2023 and was replaced. The
  gateway callsign and body template must be **settings**, not constants.

## UI (JS8 window)

A "Send SMS / Email" action (compose-area chip or ⚙ gear entry) opening a
small form:

| Field | Notes |
|---|---|
| Type | SMS / Email (selects gateway + body template) |
| To | phone number or email address, validated per type |
| Message | hard cap ~67 chars (APRS message-text limit); live count |
| Airtime estimate | frames × period from `Ft8Engine`-style frame math — a 50-char body ≈ 3–4 frames ≈ 1 min at NORMAL. Show it BEFORE send. |

Send → build packet → `js8Transmit('CMD ' + packet, '@APRSIS')` → the
existing TX progress ("TX 1/4") shows the long transmission honestly.

## Packet forms

```
SMS:   :SMSGTE   :@<number> <text>{NN
Email: :EMAIL-2  :<address> <text>{NN
```

`NN` = per-session 01–99 counter. Pure builder + padding + counter live in
`lib/aprs-is.js` (`buildSmsMessage`, `buildEmailMessage` — TO ADD), fully
unit-tested including the padding pin.

## Settings

- `js8SmsGateway` (default `SMSGTE`), `js8EmailGateway` (default `EMAIL-2`)
  — editable so a service change is a settings edit, not a release.

## Reply path (deferred)

Replies arrive on APRS-IS addressed to the sender's callsign. Delivering
them over RF requires a gateway to hold the reply and transmit it — that is
store-and-forward (see js8-store-forward-spec.md) plus gateway TX, which
crosses into automatic control. Explicitly out of scope for v1: **one-way is
a complete, useful feature**. The shipped RX-only gateway can (later) show
replies it HEARS on APRS-IS for its own operator without transmitting.

## Sequencing

1. `buildSmsMessage`/`buildEmailMessage` + tests (half a day).
2. The form + airtime estimate in the JS8 window (a day).
3. ECHOCAT: reuse the same C2S `js8-send` with the pre-built text — the
   phone form mirrors the desktop one (mobile handoff, later).
