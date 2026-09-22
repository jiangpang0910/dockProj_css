# Dock Scheduling System

A berth reservation system for a marine research facility. Vessels reserve one of a handful of
berths of different lengths for a range of days. Non-vessel uses (community sail days, campus events,
maintenance closures) take a berth too.

> Take-home project. Draft docs: [manual.md](manual.md) · [database.md](database.md) · [backend.md](backend.md) · [frontend.md](frontend.md) · [infrastructure.md](infrastructure.md) · original notes in [docs/initial_thoughts.md](docs/initial_thoughts.md)

## The problem, in one paragraph

Today the schedule is a spreadsheet grid, one sheet per year. Two things go wrong, and both are found
by a person staring at the grid:

1. **Double-booking** — two occupants on the same berth on overlapping days.
2. **Fit violation** — a vessel longer than the berth it was assigned.

The system exists so that **neither can be saved in the first place**, and so existing history can be
audited against the same rules.

## How a visitor starts

The demo is live, so there's nothing to install. Sign in and you land in **the workspace**: 23 years of the WHOI
schedule, loaded from the workbook and viewed as of 1 Jul 2019. There is one of it, and everyone shares it — what you
book, the next person sees.

## Two ways in

1. **One at a time** — the everyday path. Create a booking, get an instant yes or a precise no. This is the product.
2. **The workbook** — `npm run db:seed` reads all 23 sheets through the same rules, and everything it couldn't place
   as written lands on the Conflicts screen to place or dismiss, by hand or with the solver.

## What "done" looks like

- You can look at any date range and see who is on which berth (replaces the grid).
- You can ask "I have a 120 ft vessel arriving 3–9 March — where can it go?" and get berths that are
  free *and* long enough, tightest fit first.
- You cannot create or edit a booking that overlaps another on the same berth, puts a vessel on a berth
  shorter than it, or puts one vessel in two places at once. The rejection names the booking in the way.
- It is **forward-looking**: the point is booking the future, not re-scheduling the past.

## Not building (on purpose)

- A constraint solver / OR-Tools. Availability search plus tightest-fit ranking covers the need.
- A segment tree / interval tree. See sizing below — it would add code and gain nothing.
- Sign-up, billing, notifications. Logins are handed out (`AUTH_ACCOUNTS`), not created by users; projects belong to the login that made them.
- Rescheduling historical conflicts. Old rows are data to audit, not decisions to redo.

## What the sample data tells us

Numbers from `data_analysis/stats.py` on `sample_data/Dock Schedule - Synthetic Sample.xlsx` (heuristic parse):

| | |
|---|---|
| Span | Aug 1997 – Dec 2019 (**all in the past**; nothing is booked from 2020 on) |
| Bookings | ~2,400 total · mean ~108/yr · median ~98/yr · peak 226 (2010) · low 50 (2008) |
| Berths with a length | 6 (410′, 240′, 90′, 90′, 75′, 55′) + 2 shared sections with no length |
| Default registry | `backend/seed/extract_defaults.py` → `backend/seed/defaults.json`: 6 berths + 2 sections + 164 vessels (24′–170′) with lengths, extracted by regex. Users can create/edit/delete from there |
| Distinct vessels | ~498, of which 324 appear once |
| Non-vessel entries | ~217: events (62), closures/maintenance (51), operational notes like "ETA 1200" (104) |
| Bookings with **no berth** | ~301 (≈12%) — rows on unlabeled overflow lines |
| Vessel lengths on file | only 19 of ~498 scheduled vessels can be matched to a length in the Science/Yachts tabs |
| Source errors | wrong year in month headers (2010 sheet says "2018"); sheets 2002–04 repeat the prior December |

**Sizing consequence.** The whole 23-year history is a few thousand rows, and the busiest berth has a few
hundred bookings in total. Checking a new booking means looking at one berth's bookings — an indexed
range query returns in microseconds. A segment tree would be optimizing a step that already takes no time,
so the effort goes into **correctness and data quality** instead. If the scale were 1000× larger, an index on
`(berth_id, start_date)` would still be the first thing to try, long before a custom structure.

**What is "today"?** The data ends in 2019, but the real date is 2026. So "today" is a setting
per project: it defaults to the real date and can be overridden (the sample opens as of `2019-07-01`) to demo a
forward-looking schedule on top of the loaded past. It moves the default view and the "today" marker and
produces an `IN_PAST` *warning*; it never changes which bookings are valid.

## Design in five sentences

1. A **booking** is an inclusive date range on one berth, held by a vessel, event, or closure.
2. Three rules are enforced at write time *and* by the database itself: no overlap, vessel fits, one place at a time.
3. Workbook rows that break a rule are **never inserted** — they become conflicts you resolve or dismiss, so the bookings table is always valid.
4. Every rejection carries a machine-readable violation code and the ids of the bookings in the way.
5. A dry-run `validate` endpoint lets the UI show conflicts *before* you press save.

## Repo layout

```
README.md            this page
manual.md            operations the system must support (what a user can do, and the rules)
database.md          schema walkthrough, rules in the DB, BCNF, query costs, why Postgres
infrastructure.md    hosting (Vercel + Neon), projects/sample flow, deploy, cleanup, runbook
backend.md           services, REST API, ingestion pipeline
shared/contract.ts   THE API contract: types + zod request schemas, imported by both sides
frontend.md          the front-end prompt: design direction + screens + endpoint usage
app/, src/           the Next.js app: pages + /api route handlers (layout: backend.md §1)
db/                  migrations/0001_init.sql (the schema) + schema.test.mjs (36 DB rule tests, passing)
pipeline/            Python parse pipeline: xlsx → ParsedWorkbook JSON (regex + optional model); CLI, Vercel handler, 18 tests
backend/             Python prototypes: parse.py (the pipeline's origin), seed/ (default fleet → defaults.json)
data_analysis/       stats.py — sizing and data-quality numbers
sample_data/         the provided workbook
docs/                initial_thoughts.md (original notes, kept for reference)
```

## Stack (proposed)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | one set of types: `shared/contract.ts` |
| API | Next.js route handlers + zod | same app as the UI → one deploy, no CORS; request schemas shared with the UI via `shared/contract.ts` |
| DB | Postgres (Neon, free tier) | hosted live on Vercel, where disk is ephemeral; `EXCLUDE` constraints enforce no-overlap in the DB |
| Hosting | Vercel | live demo for the reviewer, nothing to install |
| Workbook | `exceljs` | reads merged cells |
| Frontend | Next.js + Tailwind + shadcn/ui + Motion | shadcn/ui covers forms, tables, dialogs; the schedule grid is custom |

## Open decisions — yours to confirm

Each has a default I used in the docs. Change the default here first, then the docs follow.

| # | Decision | Default |
|---|---|---|
| D1 | Are both end dates inclusive? (Does a vessel leaving on day 5 block another arriving on day 5?) | **Inclusive both ends** — matches the grid, where each day is one cell |
| D2 | Do events / closures take the whole berth? | Yes |
| D3 | Shared sections (small-craft slips, finger piers) skip overlap and length rules? | Yes |
| D4 | Tentative holds / waitlist? | Out of scope; status is only `confirmed` or `cancelled` |
| D5 | Legacy rows that break rules: insert flagged, or hold as issues? | Hold as issues (bookings table always valid) |
| D6 | Manual booking for a vessel with unknown length? | Blocked until a length is recorded |
| D7 | Operational notes ("ETA 1200", "Fuel truck") — bookings? | No; skipped and reported as info |
| D8 | "Marsh Landing" appears only in the 8-year summary tab | Not seeded as a berth |
| D9 | SQLite vs Postgres | **Postgres (Neon)**: live hosting; `EXCLUDE` makes no-overlap declarative |
| D10 | Booking in the past (before "today")? | Allowed, with an `IN_PAST` warning — not blocked |
| D11 | Concurrent users? | **One user for v1.** Later: the DB constraint serializes writes (first commit wins, no app queue); rejections go to a log (backend.md §8) |
| D12 | How far ahead can you book? | Manual bookings, measured from "today": **> 2 years → `FAR_FUTURE` warning** (catches typos like 2037 for 2027, still saveable); **> 5 years → `BEYOND_HORIZON` error** (no squatting berths for a decade; keeps R6 length edits from being frozen by far-off bookings). The seed is exempt. Sanity bounds 1997-01-01 … 2050-12-31 for everything |
| D13 | Multiple workspaces? | **No — one.** The workbook is seeded once and everyone signed in edits it (handed-out logins, username + password, no sign-up; infrastructure.md §5). Nothing creates, clones or deletes a workspace from the app |
| D14 | Where does the data come from? | The original year-per-sheet workbook, read by `npm run db:seed`. There is no upload: ingestion is a one-time seed, not a feature |
| D15 | Who parses the workbook? | **Python pipeline** (`pipeline/`), deployed as its own Vercel function. Regex first; Claude Haiku only for cells regex can't place (1 unique string in the sample), optional. TS keeps the planning window and the rules |
| D16 | What does the seed bring in? | Bookings touching the **planning window**, plus the workbook's tours and its 8-year usage summary. Violations become conflicts, never a wholesale reject |

## Status

- [x] Sample data profiled (`data_analysis/`)
- [x] Prototype grid parser (`backend/parse.py`)
- [x] Default berths + vessels extracted (`backend/seed/defaults.json`)
- [x] Design docs drafted
- [x] Schema (`db/migrations/0001_init.sql`) with DB-level rule tests passing
- [x] API contract (`shared/contract.ts`, typechecked)
- [ ] Backend: rules + services + API
- [x] `rules.ts` + dates (29 tests)
- [x] Python parse pipeline (`pipeline/`, 18 tests; sample → 2,047 rows, 8 berths, 641 vessels)
- [x] Seed staging in TS (window + rules)
- [ ] Frontend
- [ ] Tests for the rules (adjacent / same-day / contained / identical ranges)
- [ ] How-to-run section (fill in once there is something to run)
