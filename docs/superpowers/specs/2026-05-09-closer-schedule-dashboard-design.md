# Closer Schedule Dashboard — Design Spec

**Date:** 2026-05-09
**Worker:** `closer-schedule-cf`
**Domain:** `schedule.cancelmysolar.info`
**Initial campaign:** `solar-exits` (display: "Solar Elite Recovery")

## Goal

Per-campaign daily availability dashboard. Closers submit their hours (15-min granularity, in their own timezone). Manager views everyone's hours overlaid on a Central Time Gantt chart. Today is the default view. Pre-submission of future days is allowed; day-of confirmation is required to commit. No persistent history — past days roll off after 7 days via KV TTL.

## Routes

| Route | Purpose |
|---|---|
| `GET /c/{campaign}` | Closer landing — pick name, enter PIN |
| `GET /c/{campaign}/closer/{slug}?token={sessionToken}` | Closer scheduling page (post-PIN) |
| `GET /c/{campaign}/master/{master-key}` | Manager Gantt view |
| `POST /api/auth` | PIN check → session token (5-min TTL) |
| `POST /api/save` | Save hours for a date (auth required) |
| `POST /api/confirm` | Confirm a saved day (auth required) |
| `GET /api/state/{campaign}/{date}` | Read all closers' state for a date |
| `GET /api/state/{campaign}/{date}/{slug}` | Read one closer's state for a date |

## KV schema

```
cfg:campaign:{slug}
  → { name, displayName, masterKeyHash, visibleHours: [6,23],
      closers: [ { slug, name, pinHash, defaultTz: "America/Chicago" } ] }

day:{campaign}:{YYYY-MM-DD}:{closerSlug}
  → { slots: [number, number, ...]    // CT 15-min indices that are available
      submittedTz: "America/Los_Angeles",
      submittedAt: ISO8601,
      confirmedAt: ISO8601 | null,
      notes: "" }
  TTL: 9 days from save (covers 7-day window + buffer)

session:{token}
  → { campaign, closerSlug, exp }
  TTL: 300 seconds

ratelimit:pin:{campaign}:{ip}
  → counter, increments on bad PIN, ban after 5 wrong in 15 min
  TTL: 900 seconds
```

`slots` representation: array of integer slot indices, where slot 0 = 00:00 CT, slot 1 = 00:15 CT, ..., slot 95 = 23:45 CT. Always normalized to CT on save.

## Closer flow

1. Closer hits `/c/solar-exits`
2. Picks name from dropdown → PIN field appears → submits → `POST /api/auth`
3. On success, redirected to `/c/solar-exits/closer/{slug}?token=...`
4. UI:
   - **Day tabs** across top: Today | Tomorrow | next 5 days (7 total)
   - **Time zone selector** top-right; defaults to closer's `defaultTz` from config
   - **15-min grid** spanning visibleHours in selected TZ:
     - Each row = one hour
     - Each row has 4 quarter-cells
     - Click or click-and-drag to paint cells "on" / re-click to clear
   - **Notes** field below grid
   - **Save** button — POSTs to `/api/save`
5. On the **today tab** if a future-day pre-submission already exists for today:
   - Yellow banner: *"Confirm today's hours: 2pm–8pm CT"*
   - **Confirm** button → POSTs `/api/confirm`
   - Hours flip from "pending" (ghost) to "confirmed" (solid) in manager view

## Manager flow

1. Manager hits `/c/solar-exits/master/{master-key}`
2. **Day tabs** at top: Today | Tomorrow | next 5 days
3. **Gantt grid** in CT:
   - X-axis: visibleHours[0]–visibleHours[1] (default 6am–11pm), labeled hourly with 15-min sub-ticks
   - Y-axis: closer rows, sorted by earliest available slot today
   - **Solid bars** = confirmed hours
   - **Hatched/ghost bars** = pre-submitted but not confirmed
   - **Hover** → tooltip with closer's submitted-from TZ + notes + submittedAt
4. **Coverage strip** below Gantt: per-15-min cell colored by # of closers confirmed available (0=blank, 1=pale, 2+ progressively deeper)
5. Auto-refresh: 30 seconds, polls `/api/state/{campaign}/{date}`

## Auth

- **Closer PIN:** 4 digits, generated server-side at deploy, hashed (SHA-256, no salt — short fixed-length input + HMAC-style digest is enough given the 10k space and rate limit)
- **Brute-force:** 5 wrong PINs from same IP in 15 min → IP banned for 15 min on this campaign's auth endpoint
- **Session token:** 32-char random, 5-min TTL, validated on every save/confirm
- **Master key:** 24-char URL-safe random, hashed at deploy, compared on every master view request

## Time zone math

- Storage = always CT (`America/Chicago`)
- Closer-side input grid shows CT-equivalent slots in their selected TZ
- Conversion uses `Intl.DateTimeFormat` with `timeZone` option — auto handles DST
- Edge case: closer in TZ east of CT pre-submitting hours that cross midnight CT → write splits across two `day:` keys

## Visibility window

`visibleHours: [6, 23]` per campaign config. Solar Exits launches at 6am–11pm CT. Configurable per campaign without code change (just edit cfg KV).

## Out of scope (Phase 2)

- Admin panel for adding closers / campaigns without code change
- PIN reset self-service flow
- Notifications when closer hasn't confirmed by 8am their TZ
- Historical attendance review
- Multiple shifts per row (current model: closer paints any subset of slots; effectively unlimited shifts per day already)

## Acceptance criteria

1. Closer can pick name, enter PIN, save hours for today + future days in their own TZ
2. Day-of confirm flow visible only when there are saved-but-unconfirmed hours for today
3. Manager Gantt shows confirmed hours as solid bars and pending as ghost bars
4. Time zone math: closer entering "2pm–8pm" in PT shows as "4pm–10pm CT" in manager view
5. Past days >7 days old return 404 / empty (TTL-driven roll-off)
6. 5 wrong PINs from same IP triggers a 15-min ban
7. Master view auto-refreshes every 30 seconds
8. Mobile-friendly closer form (renders well on iPhone Safari at 375px width)
