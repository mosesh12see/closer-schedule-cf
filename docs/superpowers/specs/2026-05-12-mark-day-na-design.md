# Mark Day N/A — Design

**Date:** 2026-05-12
**Project:** `closer-schedule-cf` (schedule.cancelmysolar.info)
**Scope:** Closer scheduling page + master Gantt view + persistence

## Problem

Today the closer page has a "Clear day" button that wipes painted slots. The result is indistinguishable from a closer who never opened their link — both render as empty in the manager view. Manager can't tell who's actually off vs who hasn't responded.

## Goal

Closers can affirmatively mark a day "N/A — off this day" with one tap. Manager view distinguishes three states per closer × date: **has hours**, **off (N/A)**, **no response**.

## States

A closer's day is in exactly one of three states:

| State           | Trigger                                | KV shape (fields on `day:` record)                              |
| --------------- | -------------------------------------- | --------------------------------------------------------------- |
| **Has hours**   | Closer paints ≥1 slot                  | `slotsBySrcDate` non-empty, `slots` non-empty, `off` absent     |
| **Off (N/A)**   | Closer taps "Mark N/A"                 | `off: true`, `markedOffAt: <iso>`, `slotsBySrcDate` cleared     |
| **No response** | No `day:` record exists                | (no KV key)                                                     |

A `day:` record exists only when the closer has taken an action (painted slots, marked N/A, confirmed, or saved notes). Absence of the key = no response.

## Transitions

- **Paint slot → Has hours.** Any successful `/api/save` with `slots` non-empty clears any existing `off` flag (set `off: false` or delete field).
- **Mark N/A → Off.** Tap button: send `/api/save` with `off: true`. Server clears `slotsBySrcDate`, sets `off: true` and `markedOffAt`, sets `slots: []`.
- **Cancel N/A → Blank (counted as no-response).** Tap button again while off: send `/api/save` with `off: false`. Server clears the flag, leaves `slotsBySrcDate` empty, retains notes. The `day:` record still exists but with neither slots nor off, so the master summary counts this closer as no-response for the day.
- **Confirm** (existing flow): irrelevant to off state. A closer can confirm a "has hours" day; confirming an off day is not a flow we expose.

## Closer page (UI changes)

File: `src/index.js` → `CLOSER_HTML` (currently ~line 1006) and its inline JS.

- **Save bar:** rename "Clear day" button to **"Mark N/A"**.
  - When the selected day is currently in **Off** state, button reads **"Cancel N/A"**.
  - When the selected day has painted slots, button reads **"Mark N/A"** (tapping it also wipes the slots — confirmation prompt: "Mark this day off? Painted hours will be cleared.").
- **Day header strip:** for off days, render a small uppercase "N/A" badge and a muted-red marker dot (replaces the accent dot used for "has hours"). Today's "TODAY" label still wins.
- **Hour grid:** when selected day is off, render an overlay row across the grid (e.g. centered "N/A — off this day. Tap Cancel N/A to schedule hours.") and make quarter-cells non-clickable.
- **Summary line:** when off, summary reads "Off this day" instead of "No hours" / "X.X hrs".
- **Notes textarea:** still editable in off state (closer might note "family thing"). Notes persist regardless of off flag.

## Master (manager) Gantt view (UI changes)

File: `src/index.js` → `MASTER_HTML` (currently ~line 1497) and its inline JS.

- Per closer × date cell:
  - **Has hours** — existing Gantt blocks. No change.
  - **Off (N/A)** — solid muted-red bar spanning the row's full width, label "OFF" centered.
  - **No response** — existing blank/grey background. No change.
- Per-day summary header (currently shows "X on"): change to **"X on · Y off · Z no-response"**, where:
  - X = closers with non-empty `slots`
  - Y = closers with `off: true`
  - Z = closers with no `day:` record (or record with neither slots nor off)

## API changes

### `POST /api/save` (and `POST /api/team-save` — keep parity)

Extend body schema:

```
{ token, date, srcTz, slots, notes, off }       // /api/save
{ campaign, closerSlug, date, srcTz, slots, off } // /api/team-save
```

`off` is optional boolean. Semantics:

- `off: true` — clear `slotsBySrcDate` for this src-date, set `off: true`, set `markedOffAt: <iso>`, set `slots: []`. Ignore the incoming `slots` array. `notes` still persists if provided.
- `off: false` (or absent with non-empty `slots`) — clear `off` / `markedOffAt`, write slots as today.
- `off: false` with empty `slots` — treat as "cancel N/A but no hours either": clear `off` / `markedOffAt`, write `slotsBySrcDate[date] = []`, `slots: []`.

Two-shift validation (`countShifts > 2`) is skipped when `off: true` (no shifts to validate).

### `GET /api/state/{campaign}/{date}[/{slug}]`

Add `off` (boolean) and `markedOffAt` (iso | null) to each per-closer block in the response. Closer page reads them to render the off state; master view reads them to render the red bar.

## Data model

`day:{campaign}:{YYYY-MM-DD}:{closerSlug}` (existing key; existing 35-day TTL):

```json
{
  "slotsBySrcDate": { "2026-05-12": [16, 17, 18] },
  "slots": [16, 17, 18],
  "lastSrcTz": "America/Chicago",
  "submittedAt": "2026-05-12T18:23:00Z",
  "confirmedAt": null,
  "notes": "",
  "off": false,             // NEW — optional, default false / absent
  "markedOffAt": null       // NEW — optional iso when off was set
}
```

No schema migration required; old records without `off` are treated as `off: false`.

## Leaderboard

Existing leaderboard ranks closers by total scheduled hours. Off days contribute 0 hours (same as no-response today). **No change to leaderboard logic.** Off is purely a UI / manager-visibility concern.

## Out of scope

- Push/SMS notifications when someone marks off
- Reason field for N/A (free-text notes textarea already covers it)
- Bulk "mark next 5 days off" (one-tap-per-day is fine for now)
- Historical "OFF days this month" report
- Showing N/A on the team painter view (`TEAM_HTML`) — separate flow, defer until requested

## Testing checklist

Manual flow on a deployed preview against the `solar-exits` campaign (using a throwaway test closer slug):

- [ ] Mark N/A on a fresh day → master view shows red OFF bar, closer header shows N/A badge
- [ ] Mark N/A on a day with painted hours → confirmation prompt, then hours clear and day becomes OFF
- [ ] Cancel N/A → day returns to blank, button reverts to "Mark N/A"
- [ ] Paint a slot on an OFF day → off flag clears automatically, day becomes "has hours"
- [ ] Notes typed on an OFF day persist after Save and reload
- [ ] Master view summary header reads "X on · Y off · Z no-response" correctly across all 5 closers
- [ ] `/api/state` includes `off` / `markedOffAt` fields
- [ ] Reload closer page mid-flow: off state restored from server, not lost

## Files touched

- `src/index.js` — `apiSave`, `apiTeamSave`, `apiState`, `CLOSER_HTML`, `MASTER_HTML`
- (No new files, no new KV bindings, no `wrangler.toml` changes)
