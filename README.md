# Dock Scheduling System

A berth reservation system for a marine research facility. Vessels reserve one of a handful of
berths of different lengths for a range of days. Non-vessel uses (community sail days, campus events,
maintenance closures) take a berth too.

**Live:** https://dock-app-beta.vercel.app — sign in and you land in the workspace. Nothing to install.

> Docs: [manual.md](manual.md) (operations + rules) · [database.md](database.md) · [backend.md](backend.md) · [frontend.md](frontend.md) · [infrastructure.md](infrastructure.md) · original notes in [docs/initial_thoughts.md](docs/initial_thoughts.md)

## The problem, in one paragraph

Today the schedule is a spreadsheet grid, one sheet per year. Two things go wrong, and both are found
by a person staring at the grid:

1. **Double-booking** — two occupants on the same berth on overlapping days.
2. **Fit violation** — a vessel longer than the berth it was assigned.

The system exists so that **neither can be saved in the first place**, and so existing history can be
audited against the same rules.

## What you land in

23 years of the WHOI schedule (Aug 1997 – Dec 2019), read from the workbook by `npm run db:seed`:
**1,913 bookings, 8 berths, 647 vessels**, and **327 rows the workbook could not place as written**, which
become conflicts rather than being silently dropped. There is one workspace and everyone signed in shares
it — what you book, the next person sees.

The workspace opens **as of 19 June 2013**. That date is picked from the data, not the calendar: June 2013
is the only month whose following twelve carry all four conflict types, so the schedule, the Conflicts
screen and the solver all have something to show on first load. It is a setting — change it in Settings.

## Assumptions

1. **"Today" is a setting, not the clock.** The workbook ends in 2019 and the real date is 2026, so each
   workspace carries its own `asOfDate`. It moves the default view, the today marker and the `IN_PAST`
   warning. It never changes which bookings are valid.
2. **Dates are inclusive calendar days** — no times, no time zones. A booking 5–9 March occupies the 9th,
   so a vessel departing on the 9th blocks one arriving that day. This is the single most consequential
   assumption in the system; every rule below reads from it.
3. **The planning window is bounded twice.** The Conflicts screen defaults to the anchor month plus twelve
   (here 1 Jun 2013 – 31 May 2014), because a backlog stretching over 23 years is not a work queue.
   Separately, a *manual* booking ending more than **2 years** out warns (`FAR_FUTURE` — that is about as
   far ahead as a yard realistically commits, and it catches 2037-for-2027 typos) and more than **5 years**
   out is refused (`BEYOND_HORIZON`). The seed is exempt from both.
4. **A missing vessel length is a data-quality problem, not a reason to drop the booking.** 437 of the 647
   seeded vessels have no length on record. Their bookings are still loaded and still shown. The gap is
   raised only where it changes an answer: a *manual* booking of such a vessel is blocked
   (`VESSEL_LENGTH_UNKNOWN`), and the solver refuses to place it (`LENGTH_UNKNOWN`) rather than guess a fit.
   Record the length and the same row becomes placeable.
5. **A vessel in two berths on overlapping days is a conflict**, not something to merge or pick a winner for.
6. **A workbook row that breaks a rule is never inserted.** It becomes a conflict to place or dismiss, so the
   bookings table is valid at every moment — there is no "flagged but saved" state to filter out later.

## Design decisions

**The rules live in one place and are enforced in three.** `src/server/domain/rules.ts` is pure and has no
database: it decides, and returns a message plus the ids of the bookings in the way. The service layer asks
it before every write. Postgres then enforces the same thing declaratively —
`EXCLUDE USING gist (berth_id WITH =, period WITH &&) WHERE (status = 'confirmed')` — so two concurrent
requests cannot both win. If the constraint ever fires, the app logs `[rules.ts missed a rule]`, because
that means the pure layer and the database disagreed.

**A rejection is a destination, not a message.** `POST /bookings/validate` is a dry run, so the UI shows the
problem while you are still typing. When a save is blocked, the panel names the booking in the way and links
straight to it ("View blocking booking →"), so a no always comes with somewhere to go.

**A full REST surface, not just the happy path.** 35 handlers across 24 route files cover reading, creating,
editing, cancelling and deleting bookings, berths, vessels and tours, plus schedule, availability, settings
and the conflict backlog. Request and response types are shared with the UI through `shared/contract.ts`,
so a contract change breaks the build rather than production.

**CP-SAT (Google OR-Tools) places the backlog — and only into free water.** Confirmed bookings are a *fixed
world*: the solver never moves something already allocated, it only finds berths and days that are open
around them. It optimises in lexicographic stages rather than one blended score, so the ordering of goals is
explicit: place as many as possible → then minimise date shift (delay and early-arrival weighted separately)
→ then minimise wasted length → then keep to the requested days. Wasted length is in the objective because a
40′ boat should not consume the 410′ berth; **fit is not** — length is a hard candidate filter, never a
penalty, so no amount of objective pressure can squeeze a vessel into a berth too short for it. Every
unplaced claim comes back with a reason (`LENGTH_UNKNOWN`, `CLOSURE`, `NO_BERTH_LONG_ENOUGH`, `NO_ROOM`),
because "could not place 27" is not an answer a coordinator can act on.

**The solver cannot hang.** Four nested bounds: a 1–30 s limit in the request schema, `max_time_in_seconds`
per CP-SAT stage, a SIGKILL 20 s past that, and a 60 s route ceiling.

**Ingestion is a seed, not a feature.** The workbook is loaded once by `npm run db:seed` through the same
rules a manual booking goes through. There is no upload UI: a reviewer should be looking at the scheduling
product, not at a file picker.

**The schedule grid follows Google Calendar** — berths as rows, days as columns, bars you can read at a
glance — because the coordinator already knows how to use that, and the spreadsheet it replaces is the same
shape.

## Tests

`npm test` — **85 TypeScript tests**, including database-level tests that run the real migrations against an
in-process Postgres (PGlite), so the `EXCLUDE` constraints are exercised rather than mocked.
`python3 -m unittest discover -s pipeline/tests` — **105 Python tests** over the parser and the solver.

On top of the suites, the rules were checked two more ways against a **running server and a real database**:

- **A generated rule matrix — 1,351 cases, 0 failures.** Every combination of 45 date windows (before, abutting,
  arriving on the departure day, contained, identical, straddling) × occupant (the same vessel, a vessel with a
  look-alike name, an event, a closure) × target berth, sent through the dry-run `POST /bookings/validate`
  endpoint, with each answer compared against an oracle written from the rules in plain words. The point is the
  combinations a hand-written test never thinks to try — particularly that "same name" and "same vessel" are not
  the same question.
- **End-to-end through the UI, with `puppeteer-core`.** Chrome fills the real New booking form the way a person
  does, and reads what the live check says: overlap, the inclusive departure-day edge, the back-to-back control
  that must stay clean, vessel-too-long, one-place-at-a-time, two violations at once, closures and events on an
  occupied berth, reversed dates, and both horizon limits.

## What the sample data tells us

Numbers from `data_analysis/stats.py` on `sample_data/Dock Schedule - Synthetic Sample.xlsx` (heuristic parse):

| | |
|---|---|
| Span | Aug 1997 – Dec 2019 (**all in the past**; nothing is booked from 2020 on) |
| Bookings | ~2,400 total · mean ~108/yr · median ~98/yr · peak 226 (2010) · low 50 (2008) |
| Berths | 8, of which 6 carry a length (410′, 240′, 90′, 90′, 75′, 55′) |
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

## Not building (on purpose)

- Sign-up, billing, notifications. Logins are handed out (`AUTH_ACCOUNTS`), not created by users.
- Multiple workspaces. One schedule, seeded once, shared by everyone signed in.
- Upload / import UI. Ingestion is a seed (see above).
- Rescheduling historical conflicts *automatically*. Old rows are data to audit; the solver proposes, a
  person applies.

## Repo layout

```
README.md            this page
manual.md            operations the system must support (what a user can do, and the rules)
database.md          schema walkthrough, rules in the DB, BCNF, query costs, why Postgres
infrastructure.md    hosting (Vercel + Neon), deploy, cleanup, runbook
backend.md           services, REST API, ingestion pipeline
frontend.md          design direction + screens + endpoint usage
shared/contract.ts   THE API contract: types + zod request schemas, imported by both sides
src/                 the Next.js app: screens + /api route handlers + services + rules
db/                  migrations 0001–0009, seed.ts, schema.test.mjs
pipeline/            Python: dockparse (xlsx → JSON) + docksolve (CP-SAT); CLI, Vercel handler, 105 tests
test/                vitest suites, DB tests on PGlite with the real migrations
backend/             Python prototypes: parse.py (the pipeline's origin), seed/ (default fleet)
data_analysis/       stats.py — sizing and data-quality numbers
sample_data/         the provided workbook
```

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | one set of types: `shared/contract.ts` |
| API | Next.js route handlers + zod | same app as the UI → one deploy, no CORS; request schemas shared with the UI |
| DB | Postgres (Neon) | `EXCLUDE` constraints enforce no-overlap in the database itself |
| Solver | Python + OR-Tools CP-SAT | its own Vercel function; called over HTTP, or spawned as a CLI locally |
| Workbook | Python + `openpyxl` | reads merged cells; regex first, model only for cells regex can't place |
| Hosting | Vercel | live demo for the reviewer, nothing to install |
| Frontend | Next.js + Tailwind + shadcn/ui + Motion | the schedule grid is custom |

## Decisions

| # | Decision | Taken |
|---|---|---|
| D1 | Are both end dates inclusive? | **Inclusive both ends** — matches the grid, where each day is one cell |
| D2 | Do events / closures take the whole berth? | Yes |
| D3 | Berths without a recorded length | A berth may have no length; a vessel is never placed there, because no fit can be proven (`kind`/"shared section" was dropped in migration 0007 — every berth holds one occupant per day) |
| D4 | Tentative holds / waitlist? | Out of scope; status is only `confirmed` or `cancelled` |
| D5 | Legacy rows that break rules: insert flagged, or hold as conflicts? | Hold as conflicts (bookings table always valid) |
| D6 | Manual booking for a vessel with unknown length? | Blocked until a length is recorded |
| D7 | Operational notes ("ETA 1200", "Fuel truck") — bookings? | No; skipped and reported as info |
| D8 | "Marsh Landing" appears only in the 8-year summary tab | Not seeded as a berth |
| D9 | SQLite vs Postgres | **Postgres (Neon)**: live hosting; `EXCLUDE` makes no-overlap declarative |
| D10 | Booking in the past (before "today")? | Allowed, with an `IN_PAST` warning — not blocked |
| D11 | Concurrent users? | **Everyone shares one workspace.** The `EXCLUDE` constraint serializes conflicting writes — first commit wins, no application-level queue; the loser gets a precise rejection |
| D12 | How far ahead can you book? | Manual bookings, from "today": **> 2 years → `FAR_FUTURE` warning**; **> 5 years → `BEYOND_HORIZON` error**. Seed exempt. Sanity bounds 1997-01-01 … 2050-12-31 |
| D13 | Multiple workspaces? | **No — one.** Seeded once; nothing creates, clones or deletes a workspace from the app |
| D14 | Where does the data come from? | The year-per-sheet workbook, read by `npm run db:seed`. There is no upload |
| D15 | Who parses the workbook? | **Python pipeline** (`pipeline/dockparse`), its own Vercel function. Regex first; Claude Haiku only for cells regex can't place (1 unique string in the sample), optional |
| D16 | What does the seed bring in? | Bookings touching the planning window, plus the workbook's tours and its 8-year usage summary. Violations become conflicts, never a wholesale reject |
| D17 | Solve or leave the backlog alone? | **Propose, never apply.** CP-SAT fills open berths only and never moves a confirmed booking; a person applies the proposals |

## Running it locally

```bash
npm install
npm run db:migrate            # DATABASE_URL in .env.local
npm run db:seed -- --force    # loads the workbook, anchors "today" to 2013-06-19
npm run dev
npm test                      # 85 TS tests
python3 -m unittest discover -s pipeline/tests    # 105 Python tests
```
