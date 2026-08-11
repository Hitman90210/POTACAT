# Mobile handoff — JS8 mailbox (store-and-forward steps 2–5)

**From:** POTACAT desktop
**To:** ECHOCAT mobile
**Date:** 2026-08-10
**Desktop state:** shipped on master. Steps 2–5 of
`docs/js8-store-forward-spec.md` are built: the station now HOLDS mail for
other stations, SERVES `QUERY MSGS` / `QUERY MSG <ID>` (attended by default,
governor-limited), ANNOUNCES held mail inside HB ACKs, badges the Heartbeat
Map, and has the unattended opt-in (default OFF, §97.221 copy in the gear).
The owner's own mail now has a full wire channel — that is your build.

## 1. New wire (registered + demuxed; parity test green)

### S2C — owner sessions ONLY (mail is DM-class; a Guest Pass gets nothing,
not even the count-adjacent hints beyond `js8-state.mailUnread`):

- **`js8-mail { id, from, text, utc }`** — pushed the moment a message
  addressed to the owner is stored. This is your push-notification moment:
  "JS8 mail from W1AW: call me on 40m".
- **`js8-mail-list { messages }`** — full list at connect (hydration), each
  row `{ id, from, text, utc, readAt }` (`readAt` 0 = unread). Chronological.

### C2S:

- **`js8-mail-read { id }`** — mark one read; `id:"all"` marks all.
  Guest-refused. Confirmation is the `js8-state.mailUnread` echo (and the
  next `js8-mail-list` at reconnect) — no reqId.

## 2. UI to build

- **Inbox surface** — a "Mail" section on the JS8 tab (or the hamburger):
  list from `js8-mail-list`, unread bolded, tap = mark read
  (`js8-mail-read`), badge from `js8-state.mailUnread` (already flowing).
- **Push notification** on `js8-mail` while backgrounded — this is the whole
  point of the feature ("an unattended station you find out about").
- Mail rows are NOT threads — they're stored mail (may arrive relayed later
  than the conversation). Keep the surface distinct from conversations.

## 3. New `js8-state` fields (already declared in the registry)

| Field | Meaning |
|---|---|
| `mailHold` | ⚙ "Hold mail for other stations" (default true). Display-only unless you want the setter on the wire — ask. |
| `mailUnattended` | ⚙ "Serve mail while away" (default false). If you surface it, carry the warning: serving queries >30 min idle is automatic control; on 20m (14.078) that is not a §97.221 sub-band — the licensee's call. Recommend display-only on mobile. |

## 4. Behavior notes (host-enforced; nothing for you to implement)

- Serving is gated: attended (operator active <30 min, or the unattended
  opt-in), SWR/TX/radio-owner guards, and a duty-cycle governor (~120 s of
  mail TX per rolling hour, max 4 serves per station per hour). Refusals are
  logged, never transmitted.
- HB ACKs now append `MSG ID <id>` when the ACKed station has mail waiting —
  you may see it in thread text; no special handling needed.
- The desktop Heartbeat Map badges stations the operator holds mail for
  (`mailFor` in its data); if you build the mobile map later this rides the
  same `js8-heard-by` ask as before.
